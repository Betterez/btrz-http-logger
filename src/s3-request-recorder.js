"use strict";

const os = require("os");
const path = require("path");
const fsp = require("fs").promises;
const {PutObjectCommand, S3Client} = require("@aws-sdk/client-s3");

function parseQueryFromUrl(url) {
  if (!url || typeof url !== "string") {
    return {};
  }
  const qIndex = url.indexOf("?");
  if (qIndex === -1) {
    return {};
  }
  const params = new URLSearchParams(url.slice(qIndex + 1));
  const query = {};
  for (const [key, value] of params) {
    query[key] = value;
  }
  return query;
}

function resolveQuery(req) {
  if (req.query && typeof req.query === "object") {
    return req.query;
  }
  const urlQuery = parseQueryFromUrl(req.url);
  if (Object.keys(urlQuery).length > 0) {
    return urlQuery;
  }
  return parseQueryFromUrl(req.originalUrl);
}

function buildRecord(req, now) {
  const record = {
    ts: now.toISOString(),
    method: req.method,
    url: req.url || req.originalUrl || "",
    path: req.path || (req.url || "").split("?")[0] || "",
    query: resolveQuery(req),
    headers: req.headers || {}
  };

  if (req.body !== undefined) {
    record.body = req.body;
  }

  return record;
}

function serializeRecord(record) {
  try {
    return `${JSON.stringify(record)}\n`;
  } catch (_err) {
    const withoutBody = Object.assign({}, record);
    delete withoutBody.body;
    return `${JSON.stringify(withoutBody)}\n`;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function getWindowStart(date, windowMinutes) {
  const d = new Date(date.getTime());
  d.setUTCSeconds(0, 0);
  const mins = d.getUTCMinutes();
  d.setUTCMinutes(mins - (mins % windowMinutes));
  return d;
}

function buildS3Key({prefix, windowStart, instanceId}) {
  const yyyy = windowStart.getUTCFullYear();
  const MM = pad2(windowStart.getUTCMonth() + 1);
  const dd = pad2(windowStart.getUTCDate());
  const HHmm = `${pad2(windowStart.getUTCHours())}${pad2(windowStart.getUTCMinutes())}`;
  const normalized = String(prefix || "").replace(/^\/+|\/+$/g, "");
  const base = `${yyyy}/${MM}/${dd}/${HHmm}-${instanceId}.ndjson`;
  return normalized ? `${normalized}/${base}` : base;
}

function safelyLog(logger, level, message, data) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  try {
    if (data === undefined) {
      logger[level](message);
    } else {
      logger[level](message, data);
    }
  } catch (_err) {}
}

/**
 * @param {Object} config
 * @param {string} config.bucket
 * @param {string} [config.prefix]
 * @param {string} [config.region]
 * @param {number} [config.windowMinutes=15]
 * @param {string} [config.instanceId]
 * @param {string} [config.tempDir]
 * @param {import("@aws-sdk/client-s3").S3Client} [config.s3Client]
 * @param {Function} [config.onSignal] - test seam for process signal registration
 * @param {import("btrz-logger").Logger} logger - btrz-logger instance (`info`, `error`, …)
 */
function s3RequestRecorder(config = {}, logger) {
  if (!config.bucket || !logger) {
    let warned = false;
    return function noopS3RequestRecorder(req, res, next) {
      if (!warned) {
        warned = true;
        if (logger) {
          safelyLog(
            logger,
            "error",
            "[btrz-http-logger] s3RequestRecorder: missing bucket; middleware disabled"
          );
        }
      }
      next();
    };
  }

  const bucket = config.bucket;
  const prefix = config.prefix || "";
  const windowMinutes = config.windowMinutes == null ? 15 : config.windowMinutes;
  const instanceId = config.instanceId || `${os.hostname()}-${process.pid}`;
  const tempDir = config.tempDir || os.tmpdir();
  const s3Client = config.s3Client || new S3Client(config.region ? {region: config.region} : {});
  let activeWindowStartMs = null;
  let activeTempPath = null;
  const inFlightAppends = new Map();

  function ensureTempPath(windowStart) {
    const stamp = windowStart.toISOString().replace(/[:.]/g, "-");
    return path.join(tempDir, `btrz-http-logger-${instanceId}-${stamp}.ndjson`);
  }

  function trackAppend(filePath, line) {
    const previousAppend = inFlightAppends.get(filePath) || Promise.resolve();
    const append = previousAppend
      .then(() => fsp.mkdir(tempDir, {recursive: true}))
      .then(() => fsp.appendFile(filePath, line, "utf8"))
      .catch((err) => {
        safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder append failed", err);
      });

    inFlightAppends.set(filePath, append);
    append.then(() => {
      if (inFlightAppends.get(filePath) === append) {
        inFlightAppends.delete(filePath);
      }
    });
  }

  function flushFile(filePath, windowStart) {
    const work = Promise.resolve()
      .then(() => inFlightAppends.get(filePath) || Promise.resolve())
      .then(() => fsp.readFile(filePath))
      .then((body) => {
        if (!body || !body.length) {
          return null;
        }
        return s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: buildS3Key({prefix, windowStart, instanceId}),
            Body: body,
            ContentType: "application/x-ndjson"
          })
        );
      })
      .catch((err) => {
        safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder S3 upload failed", err);
      })
      .finally(() => fsp.unlink(filePath).catch((err) => {
        safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder temp delete failed", err);
      }));

    work.catch(() => {});
  }

  const registerSignal = config.onSignal || ((event, handler) => {
    process.on(event, handler);
  });

  function flushActive() {
    if (!activeTempPath || activeWindowStartMs == null) {
      return;
    }
    const filePath = activeTempPath;
    const windowStart = new Date(activeWindowStartMs);
    activeTempPath = null;
    activeWindowStartMs = null;
    flushFile(filePath, windowStart);
  }

  try {
    registerSignal("SIGTERM", flushActive);
    registerSignal("SIGINT", flushActive);
  } catch (_err) {}

  return function s3RequestRecorderMiddleware(req, res, next) {
    try {
      const now = new Date();
      const windowStart = getWindowStart(now, windowMinutes);
      if (activeWindowStartMs !== windowStart.getTime()) {
        if (activeWindowStartMs !== null) {
          flushFile(activeTempPath, new Date(activeWindowStartMs));
        }
        activeWindowStartMs = windowStart.getTime();
        activeTempPath = ensureTempPath(windowStart);
      }

      const line = serializeRecord(buildRecord(req, now));
      trackAppend(activeTempPath, line);
    } catch (err) {
      safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder record failed", err);
    }
    next();
  };
}

module.exports = {s3RequestRecorder, buildS3Key, getWindowStart};

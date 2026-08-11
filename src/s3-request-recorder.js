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

function s3RequestRecorder(config = {}) {
  const warn = config.warn || console.warn;
  const logError = config.logError || ((err, msg) => console.error(msg, err));
  const fs = config.fs || fsp;
  const nowFn = config.now || (() => new Date());

  if (!config.bucket) {
    let warned = false;
    return function noopS3RequestRecorder(req, res, next) {
      if (!warned) {
        warned = true;
        try {
          warn("[btrz-http-logger] s3RequestRecorder: missing bucket; middleware disabled");
        } catch (_err) {}
      }
      next();
    };
  }

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

  function safelyLogError(err, message) {
    try {
      logError(err, message);
    } catch (_err) {}
  }

  function trackAppend(filePath, line) {
    const previousAppend = inFlightAppends.get(filePath) || Promise.resolve();
    const append = previousAppend
      .then(() => fs.mkdir(tempDir, {recursive: true}))
      .then(() => fs.appendFile(filePath, line, "utf8"))
      .catch((err) => {
        safelyLogError(err, "[btrz-http-logger] s3RequestRecorder append failed");
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
      .then(() => fs.readFile(filePath))
      .then((body) => {
        if (!body || !body.length) {
          return null;
        }
        return s3Client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: buildS3Key({prefix: config.prefix, windowStart, instanceId}),
            Body: body,
            ContentType: "application/x-ndjson"
          })
        );
      })
      .catch((err) => {
        safelyLogError(err, "[btrz-http-logger] s3RequestRecorder S3 upload failed");
      })
      .finally(() => fs.unlink(filePath).catch((err) => {
        safelyLogError(err, "[btrz-http-logger] s3RequestRecorder temp delete failed");
      }));

    work.catch(() => {});
  }

  return function s3RequestRecorderMiddleware(req, res, next) {
    try {
      const now = nowFn();
      const windowStart = getWindowStart(now, windowMinutes);
      if (activeWindowStartMs !== windowStart.getTime()) {
        if (activeWindowStartMs !== null) {
          flushFile(activeTempPath, new Date(activeWindowStartMs));
        }
        activeWindowStartMs = windowStart.getTime();
        activeTempPath = ensureTempPath(windowStart);
      }

      const line = serializeRecord(buildRecord(req, now));
      const filePath = activeTempPath;
      trackAppend(filePath, line);
    } catch (err) {
      safelyLogError(err, "[btrz-http-logger] s3RequestRecorder record failed");
    }
    next();
  };
}

module.exports = {s3RequestRecorder, buildS3Key, getWindowStart};

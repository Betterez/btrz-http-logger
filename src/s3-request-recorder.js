"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const fsp = fs.promises;
const {GetObjectCommand, PutObjectCommand, S3Client} = require("@aws-sdk/client-s3");
const {sanitizeRecord} = require("./sanitize-card-data");

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

  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString("utf8");
    if (Buffer.from(text, "utf8").equals(req.body)) {
      record.body = text;
    }
  } else if (req.body !== undefined) {
    record.body = req.body;
  }

  return record;
}

function cloneRecord(req, now) {
  const record = buildRecord(req, now);
  try {
    return JSON.parse(JSON.stringify(record));
  } catch (_err) {
    const withoutBody = buildRecord(req, now);
    delete withoutBody.body;
    try {
      return JSON.parse(JSON.stringify(withoutBody));
    } catch (_fallbackErr) {
      return {
        ts: now.toISOString(),
        method: req.method,
        url: req.url || req.originalUrl || "",
        path: req.path || (req.url || "").split("?")[0] || "",
        query: {},
        headers: {}
      };
    }
  }
}

function snapshotRecord(req, now) {
  const record = cloneRecord(req, now);
  try {
    return sanitizeRecord(record);
  } catch (_err) {
    const withoutBody = Object.assign({}, record);
    delete withoutBody.body;
    return sanitizeRecord(withoutBody);
  }
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

function isS3ObjectNotFound(err) {
  return Boolean(
    err &&
    (err.name === "NoSuchKey" ||
      err.code === "NoSuchKey" ||
      err.statusCode === 404 ||
      (err.$metadata && err.$metadata.httpStatusCode === 404))
  );
}

async function bodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (typeof body.transformToString === "function") {
    return Buffer.from(await body.transformToString(), "utf8");
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function hasExplicitCredentials(credentials) {
  return Boolean(
    credentials &&
    credentials.accessKeyId &&
    credentials.secretAccessKey
  );
}

/**
 * @param {Object} config
 * @param {string} config.bucket
 * @param {string} config.region
 * @param {{accessKeyId: string, secretAccessKey: string, sessionToken?: string}} config.credentials
 * @param {string} [config.prefix]
 * @param {number} [config.windowMinutes=15]
 * @param {string} [config.instanceId]
 * @param {string} [config.tempDir]
 * @param {Function} [config.onSignal] - test seam for process signal registration
 * @param {import("btrz-logger").Logger} logger - btrz-logger instance (`info`, `error`, …)
 */
function s3RequestRecorder(config = {}, logger) {
  if (!config.bucket || !config.region || !hasExplicitCredentials(config.credentials) || !logger) {
    let warned = false;
    return function noopS3RequestRecorder(req, res, next) {
      if (!warned) {
        warned = true;
        if (logger) {
          safelyLog(
            logger,
            "error",
            "[btrz-http-logger] s3RequestRecorder: missing bucket, region, or credentials; middleware disabled"
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
  const credentials = {
    accessKeyId: config.credentials.accessKeyId,
    secretAccessKey: config.credentials.secretAccessKey
  };
  if (config.credentials.sessionToken) {
    credentials.sessionToken = config.credentials.sessionToken;
  }
  const s3Client = new S3Client({
    region: config.region,
    credentials
  });
  let activeWindowStartMs = null;
  let activeTempPath = null;
  const inFlightAppends = new Map();
  const pendingFinalizers = new Map();
  const flushWhenIdle = new Map();
  const pathEpoch = new Map();
  const flushChains = new Map();
  const uploadedKeys = new Set();
  let sealedFileSequence = 0;

  fsp.mkdir(tempDir, {recursive: true}).catch((err) => {
    safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder tempDir mkdir failed", err);
  });

  function ensureTempPath(windowStart) {
    const stamp = windowStart.toISOString().replace(/[:.]/g, "-");
    return path.join(tempDir, `btrz-http-logger-${instanceId}-${stamp}.ndjson`);
  }

  function trackAppend(filePath, line) {
    const previousAppend = inFlightAppends.get(filePath) || Promise.resolve();
    const append = previousAppend
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

  function deferFlushForChangedState(filePath, windowStart, epoch) {
    const pending = pendingFinalizers.get(filePath) || 0;
    if (pending === 0 && (pathEpoch.get(filePath) || 0) === epoch) {
      return null;
    }
    flushWhenIdle.set(filePath, windowStart);
    return pending > 0 ? "pending" : "stale";
  }

  function flushFile(filePath, windowStart, forceSeal = false) {
    const previousFlush = flushChains.get(filePath) || Promise.resolve();
    const work = previousFlush.catch(() => {}).then(async () => {
      while (true) {
        const epoch = pathEpoch.get(filePath) || 0;

        await (inFlightAppends.get(filePath) || Promise.resolve());
        if (forceSeal) {
          if ((pendingFinalizers.get(filePath) || 0) > 0) {
            flushWhenIdle.set(filePath, windowStart);
          }
        } else {
          let changedState = deferFlushForChangedState(filePath, windowStart, epoch);
          if (changedState === "pending") {
            return;
          }
          if (changedState === "stale") {
            continue;
          }

          changedState = deferFlushForChangedState(filePath, windowStart, epoch);
          if (changedState === "pending") {
            return;
          }
          if (changedState === "stale") {
            continue;
          }
        }

        const sealedPath = `${filePath}.${process.pid}.${Date.now()}.${sealedFileSequence++}.uploading`;
        if (!forceSeal || (pendingFinalizers.get(filePath) || 0) === 0) {
          flushWhenIdle.delete(filePath);
        }
        // renameSync must run immediately after the last synchronous pending/epoch check
        // with no await in between, so finalize cannot append to the pre-seal path during seal.
        try {
          fs.renameSync(filePath, sealedPath);
        } catch (err) {
          if (err && err.code === "ENOENT") {
            return;
          }
          safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder temp seal failed", err);
          return;
        }

        let preserveSealed = false;
        try {
          const body = await fsp.readFile(sealedPath);
          if (body && body.length) {
            const key = buildS3Key({prefix, windowStart, instanceId});
            let existingBody = Buffer.alloc(0);
            let mergeGetFailed = false;
            if (uploadedKeys.has(key)) {
              // Subsequent partial flushes require s3:GetObject on the bucket to merge.
              try {
                const existingObject = await s3Client.send(
                  new GetObjectCommand({
                    Bucket: bucket,
                    Key: key
                  })
                );
                existingBody = await bodyToBuffer(existingObject.Body);
              } catch (err) {
                if (!isS3ObjectNotFound(err)) {
                  mergeGetFailed = true;
                  safelyLog(
                    logger,
                    "error",
                    "[btrz-http-logger] s3RequestRecorder GetObject failed; uploading sealed body without merge",
                    err
                  );
                }
              }
            }
            try {
              await s3Client.send(
                new PutObjectCommand({
                  Bucket: bucket,
                  Key: key,
                  Body: Buffer.concat([existingBody, body]),
                  ContentType: "application/x-ndjson"
                })
              );
              uploadedKeys.add(key);
            } catch (err) {
              preserveSealed = mergeGetFailed;
              throw err;
            }
          }
        } catch (err) {
          safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder S3 upload failed", err);
        } finally {
          if (preserveSealed) {
            safelyLog(
              logger,
              "error",
              "[btrz-http-logger] s3RequestRecorder preserved sealed temp file after merge and upload failures",
              {sealedPath}
            );
          } else {
            await fsp.unlink(sealedPath).catch((err) => {
              safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder temp delete failed", err);
            });
          }
        }
        if ((pendingFinalizers.get(filePath) || 0) === 0) {
          pathEpoch.delete(filePath);
        }
        return;
      }
    });

    flushChains.set(filePath, work);
    work.then(() => {
      if (flushChains.get(filePath) === work) {
        flushChains.delete(filePath);
      }
    }, () => {
      if (flushChains.get(filePath) === work) {
        flushChains.delete(filePath);
      }
    });
    work.catch(() => {});
  }

  function bumpPending(filePath) {
    pendingFinalizers.set(filePath, (pendingFinalizers.get(filePath) || 0) + 1);
    pathEpoch.set(filePath, (pathEpoch.get(filePath) || 0) + 1);
  }

  function scheduleFlush(filePath, windowStart) {
    if (!filePath) {
      return;
    }
    const pending = pendingFinalizers.get(filePath) || 0;
    if (pending > 0) {
      flushWhenIdle.set(filePath, windowStart);
      return;
    }
    flushWhenIdle.delete(filePath);
    flushFile(filePath, windowStart);
  }

  function releasePending(filePath) {
    const current = pendingFinalizers.get(filePath) || 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      pendingFinalizers.delete(filePath);
    } else {
      pendingFinalizers.set(filePath, next);
    }
    if (next === 0 && flushWhenIdle.has(filePath)) {
      const windowStart = flushWhenIdle.get(filePath);
      flushWhenIdle.delete(filePath);
      flushFile(filePath, windowStart);
    }
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
    flushFile(filePath, windowStart, true);
  }

  try {
    registerSignal("SIGTERM", flushActive);
    registerSignal("SIGINT", flushActive);
  } catch (_err) {}

  return function s3RequestRecorderMiddleware(req, res, next) {
    try {
      const now = new Date();
      const startMs = now.getTime();
      const windowStart = getWindowStart(now, windowMinutes);
      if (activeWindowStartMs !== windowStart.getTime()) {
        if (activeWindowStartMs !== null) {
          scheduleFlush(activeTempPath, new Date(activeWindowStartMs));
        }
        activeWindowStartMs = windowStart.getTime();
        activeTempPath = ensureTempPath(windowStart);
      }

      const tempPath = activeTempPath;
      const record = snapshotRecord(req, now);
      let finalized = false;

      function finalize(aborted) {
        if (finalized) {
          return;
        }
        finalized = true;
        try {
          record.status = typeof res.statusCode === "number" ? res.statusCode : 0;
          record.durationMs = Math.max(0, new Date().getTime() - startMs);
          if (aborted) {
            record.aborted = true;
          }
          trackAppend(tempPath, serializeRecord(record));
        } catch (err) {
          safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder finalize failed", err);
        } finally {
          releasePending(tempPath);
        }
      }

      if (res && typeof res.on === "function") {
        try {
          res.on("finish", () => finalize(false));
          res.on("close", () => {
            if (!finalized) {
              finalize(true);
            }
          });
          bumpPending(tempPath);
        } catch (err) {
          finalized = true;
          throw err;
        }
      }
    } catch (err) {
      safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder record failed", err);
    }
    next();
  };
}

module.exports = {s3RequestRecorder, buildS3Key, getWindowStart};

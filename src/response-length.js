"use strict";

const BTRZ_HTTP_LOGGER_BODY_SIZE_KEY = Symbol("btrzHttpLoggerBodyBytes");

function chunkByteLength(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === "function") {
    return 0;
  }
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8");
  }
  return chunk.byteLength || 0;
}

/**
 * Express middleware that counts the body bytes passed to res.write() and res.end(), so the response length can be
 * logged for streamed (chunked) responses that have no Content-Length header.
 */
function countResponseBytes(req, res, next) {
  const originalWrite = res.write;
  const originalEnd = res.end;
  res[BTRZ_HTTP_LOGGER_BODY_SIZE_KEY] = 0;

  res.write = function countedWrite(...args) {
    res[BTRZ_HTTP_LOGGER_BODY_SIZE_KEY] += chunkByteLength(args[0], args[1]);
    return originalWrite.apply(this, args);
  };

  res.end = function countedEnd(...args) {
    res[BTRZ_HTTP_LOGGER_BODY_SIZE_KEY] += chunkByteLength(args[0], args[1]);
    return originalEnd.apply(this, args);
  };

  next();
}

/**
 * Morgan token: the Content-Length header when present, otherwise the number of body bytes counted by
 * countResponseBytes.  Undefined (logged as "-") when no headers were sent.
 */
function responseLength(req, res) {
  if (!res.headersSent) {
    return undefined;
  }
  const header = res.getHeader("content-length");
  if (header !== undefined) {
    return String(header);
  }
  return res[BTRZ_HTTP_LOGGER_BODY_SIZE_KEY] === undefined ? undefined : String(res[BTRZ_HTTP_LOGGER_BODY_SIZE_KEY]);
}

module.exports = {
  countResponseBytes,
  responseLength
};

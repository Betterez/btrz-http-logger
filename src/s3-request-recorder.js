"use strict";

function s3RequestRecorder(config = {}) {
  const warn = config.warn || console.warn;
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

  // full implementation filled in later tasks
  return function s3RequestRecorderMiddleware(req, res, next) {
    next();
  };
}

module.exports = {s3RequestRecorder};

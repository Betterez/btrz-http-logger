"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const recorderPath = path.resolve(__dirname, "..", "src", "s3-request-recorder.js");
const indexPath = path.resolve(__dirname, "..", "index.js");

test("s3RequestRecorder is exported from package entry", () => {
  delete require.cache[indexPath];
  delete require.cache[recorderPath];
  const httpLogger = require("..");
  assert.equal(typeof httpLogger.s3RequestRecorder, "function");
});

test("returns no-op middleware when bucket is missing", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const warnings = [];
  const mw = s3RequestRecorder({
    logError: () => {},
    warn: (msg) => warnings.push(msg)
  });
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  assert.equal(warnings.length, 1);
});

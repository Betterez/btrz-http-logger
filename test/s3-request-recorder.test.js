"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const recorderPath = path.resolve(__dirname, "..", "src", "s3-request-recorder.js");
const indexPath = path.resolve(__dirname, "..", "index.js");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

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

test("returns no-op middleware when bucket is empty string", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const warnings = [];
  const mw = s3RequestRecorder({
    bucket: "",
    logError: () => {},
    warn: (msg) => warnings.push(msg)
  });
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  mw({method: "POST", url: "/other"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing bucket/);
});

test("calls next without waiting for append or upload", async () => {
  const appendStarted = createDeferred();
  const appendFinished = createDeferred();
  const putFinished = createDeferred();
  const calls = {next: 0, append: 0, put: 0};

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-http-logger-test",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    fs: {
      async mkdir() {},
      async appendFile() {
        calls.append += 1;
        appendStarted.resolve();
        await appendFinished.promise;
      },
      async readFile() {
        return "";
      },
      async unlink() {}
    },
    s3Client: {
      send: async () => {
        calls.put += 1;
        await putFinished.promise;
        return {};
      }
    },
    logError: () => {}
  });

  mw(
    {
      method: "POST",
      url: "/v1/orders?foo=1",
      path: "/v1/orders",
      query: {foo: "1"},
      headers: {"x-api-key": "secret"},
      body: {a: 1}
    },
    {},
    () => {
      calls.next += 1;
    }
  );

  assert.equal(calls.next, 1);
  await appendStarted.promise;
  assert.equal(calls.append, 1);
  assert.equal(calls.put, 0);
  appendFinished.resolve();
});

test("writes NDJSON with method url headers query and body when present", async () => {
  const lines = [];
  const appendDone = createDeferred();

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    fs: {
      async mkdir() {},
      async appendFile(_path, data) {
        lines.push(data);
        appendDone.resolve();
      },
      async readFile() {
        return "";
      },
      async unlink() {}
    },
    s3Client: {send: async () => ({})},
    logError: () => {}
  });

  mw(
    {
      method: "POST",
      url: "/v1/orders?foo=1",
      path: "/v1/orders",
      query: {foo: "1"},
      headers: {host: "example"},
      body: {a: 1}
    },
    {},
    () => {}
  );

  await appendDone.promise;
  const record = JSON.parse(lines[0].trim());
  assert.equal(record.method, "POST");
  assert.equal(record.url, "/v1/orders?foo=1");
  assert.equal(record.path, "/v1/orders");
  assert.deepEqual(record.query, {foo: "1"});
  assert.deepEqual(record.headers, {host: "example"});
  assert.deepEqual(record.body, {a: 1});
  assert.equal(record.ts, "2026-08-11T03:16:00.000Z");
});

test("parses query from url when req.query is missing", async () => {
  const lines = [];
  const appendDone = createDeferred();

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    fs: {
      async mkdir() {},
      async appendFile(_path, data) {
        lines.push(data);
        appendDone.resolve();
      },
      async readFile() {
        return "";
      },
      async unlink() {}
    },
    s3Client: {send: async () => ({})},
    logError: () => {}
  });

  mw(
    {
      method: "GET",
      url: "/v1/orders?foo=1",
      path: "/v1/orders",
      headers: {}
    },
    {},
    () => {}
  );

  await appendDone.promise;
  const record = JSON.parse(lines[0].trim());
  assert.deepEqual(record.query, {foo: "1"});
});

test("parses query from originalUrl when req.query and url lack querystring", async () => {
  const lines = [];
  const appendDone = createDeferred();

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    fs: {
      async mkdir() {},
      async appendFile(_path, data) {
        lines.push(data);
        appendDone.resolve();
      },
      async readFile() {
        return "";
      },
      async unlink() {}
    },
    s3Client: {send: async () => ({})},
    logError: () => {}
  });

  mw(
    {
      method: "GET",
      url: "/v1/orders",
      originalUrl: "/v1/orders?bar=2",
      path: "/v1/orders",
      headers: {}
    },
    {},
    () => {}
  );

  await appendDone.promise;
  const record = JSON.parse(lines[0].trim());
  assert.deepEqual(record.query, {bar: "2"});
});

test("omits body when req.body is undefined", async () => {
  const lines = [];
  const appendDone = createDeferred();

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    fs: {
      async mkdir() {},
      async appendFile(_path, data) {
        lines.push(data);
        appendDone.resolve();
      },
      async readFile() {
        return "";
      },
      async unlink() {}
    },
    s3Client: {send: async () => ({})},
    logError: () => {}
  });

  mw(
    {
      method: "GET",
      url: "/",
      path: "/",
      query: {},
      headers: {}
    },
    {},
    () => {}
  );

  await appendDone.promise;
  const record = JSON.parse(lines[0].trim());
  assert.equal(Object.prototype.hasOwnProperty.call(record, "body"), false);
});

test("buildS3Key uses UTC window start and instanceId", () => {
  delete require.cache[recorderPath];
  const {buildS3Key} = require("../src/s3-request-recorder");
  const key = buildS3Key({
    prefix: "http-requests/sales",
    windowStart: new Date("2026-08-11T03:15:00.000Z"),
    instanceId: "i-abc123"
  });
  assert.equal(key, "http-requests/sales/2026/08/11/0315-i-abc123.ndjson");
});

test("buildS3Key normalizes prefix slashes", () => {
  delete require.cache[recorderPath];
  const {buildS3Key} = require("../src/s3-request-recorder");
  assert.equal(
    buildS3Key({
      prefix: "/http-requests/sales/",
      windowStart: new Date("2026-08-11T03:15:00.000Z"),
      instanceId: "i-1"
    }),
    "http-requests/sales/2026/08/11/0315-i-1.ndjson"
  );
  assert.equal(
    buildS3Key({
      prefix: "",
      windowStart: new Date("2026-08-11T03:15:00.000Z"),
      instanceId: "i-1"
    }),
    "2026/08/11/0315-i-1.ndjson"
  );
});

test("calls next even when append fails asynchronously", async () => {
  const errors = [];
  const appendDone = createDeferred();

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    fs: {
      async mkdir() {},
      async appendFile() {
        appendDone.resolve();
        throw new Error("disk full");
      },
      async readFile() {
        return "";
      },
      async unlink() {}
    },
    s3Client: {send: async () => ({})},
    logError: (err, msg) => errors.push({err, msg})
  });

  let nextCalled = 0;
  mw({method: "GET", url: "/", path: "/", query: {}, headers: {}}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  await appendDone.promise;
  await new Promise((r) => setImmediate(r));
  assert.ok(errors.length >= 1);
});

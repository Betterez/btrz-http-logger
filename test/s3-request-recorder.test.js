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

function noopOnSignal() {}

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
    onSignal: noopOnSignal,
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
    onSignal: noopOnSignal,
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
    onSignal: noopOnSignal,
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
    onSignal: noopOnSignal,
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
    onSignal: noopOnSignal,
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

test("calls next and omits body when req.body is circular", async () => {
  const lines = [];
  const appendDone = createDeferred();
  const circular = {a: 1};
  circular.self = circular;

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    now: () => new Date("2026-08-11T03:16:00.000Z"),
    onSignal: noopOnSignal,
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

  let nextCalled = 0;
  mw(
    {
      method: "POST",
      url: "/",
      path: "/",
      query: {},
      headers: {},
      body: circular
    },
    {},
    () => {
      nextCalled += 1;
    }
  );

  assert.equal(nextCalled, 1);
  await appendDone.promise;
  const record = JSON.parse(lines[0].trim());
  assert.equal(record.method, "POST");
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
    onSignal: noopOnSignal,
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

test("flushes previous window to S3 and deletes temp file on success", async () => {
  const files = new Map();
  const puts = [];
  const unlinks = [];
  let currentNow = new Date("2026-08-11T03:16:00.000Z");

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder({
    bucket: "my-bucket",
    prefix: "http-requests/sales",
    instanceId: "i-abc123",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
    onSignal: noopOnSignal,
    fs: {
      async mkdir() {},
      async appendFile(filePath, data) {
        files.set(filePath, (files.get(filePath) || "") + data);
      },
      async readFile(filePath) {
        if (!files.has(filePath)) {
          throw Object.assign(new Error("ENOENT"), {code: "ENOENT"});
        }
        return files.get(filePath);
      },
      async unlink(filePath) {
        unlinks.push(filePath);
        files.delete(filePath);
      }
    },
    s3Client: {
      send: async (command) => {
        puts.push(command.input || command);
        return {};
      }
    },
    logError: () => {}
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  currentNow = new Date("2026-08-11T03:30:00.000Z");
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(puts.length, 1);
  assert.equal(puts[0].Bucket, "my-bucket");
  assert.equal(puts[0].Key, "http-requests/sales/2026/08/11/0315-i-abc123.ndjson");
  assert.equal(puts[0].ContentType, "application/x-ndjson");
  assert.match(String(puts[0].Body), /"url":"\/a"/);
  assert.equal(unlinks.length, 1);
});

test("on upload failure logs error and still deletes temp file", async () => {
  const files = new Map();
  const unlinks = [];
  const errors = [];
  let currentNow = new Date("2026-08-11T03:16:00.000Z");

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder({
    bucket: "my-bucket",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
    onSignal: noopOnSignal,
    fs: {
      async mkdir() {},
      async appendFile(filePath, data) {
        files.set(filePath, (files.get(filePath) || "") + data);
      },
      async readFile(filePath) {
        return files.get(filePath) || "";
      },
      async unlink(filePath) {
        unlinks.push(filePath);
        files.delete(filePath);
      }
    },
    s3Client: {
      send: async () => {
        throw new Error("S3 down");
      }
    },
    logError: (err, msg) => errors.push({err, msg})
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  currentNow = new Date("2026-08-11T03:30:00.000Z");
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(errors.some((entry) => /S3|upload/i.test(String(entry.msg)) || /S3 down/.test(String(entry.err))));
  assert.equal(unlinks.length, 1);
});

test("next is called before flush upload resolves", async () => {
  const uploadGate = createDeferred();
  const files = new Map();
  let currentNow = new Date("2026-08-11T03:16:00.000Z");

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
    onSignal: noopOnSignal,
    fs: {
      async mkdir() {},
      async appendFile(filePath, data) {
        files.set(filePath, (files.get(filePath) || "") + data);
      },
      async readFile(filePath) {
        return files.get(filePath) || "";
      },
      async unlink() {}
    },
    s3Client: {
      send: async () => uploadGate.promise
    },
    logError: () => {}
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  currentNow = new Date("2026-08-11T03:30:00.000Z");

  let nextCalled = 0;
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  uploadGate.resolve();
});

test("flush waits for an in-flight append before uploading", async () => {
  const appendStarted = createDeferred();
  const appendFinished = createDeferred();
  const puts = [];
  let currentNow = new Date("2026-08-11T03:16:00.000Z");

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
    onSignal: noopOnSignal,
    fs: {
      async mkdir() {},
      async appendFile() {
        appendStarted.resolve();
        await appendFinished.promise;
      },
      async readFile() {
        return '{"url":"/a"}\n';
      },
      async unlink() {}
    },
    s3Client: {
      send: async (command) => puts.push(command.input || command)
    },
    logError: () => {}
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await appendStarted.promise;
  currentNow = new Date("2026-08-11T03:30:00.000Z");
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts.length, 0);

  appendFinished.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(puts.length, 1);
});

test("skips S3 upload for an empty previous file but deletes it", async () => {
  const unlinks = [];
  const puts = [];
  let currentNow = new Date("2026-08-11T03:16:00.000Z");

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
    onSignal: noopOnSignal,
    fs: {
      async mkdir() {},
      async appendFile() {},
      async readFile() {
        return "";
      },
      async unlink(filePath) {
        unlinks.push(filePath);
      }
    },
    s3Client: {
      send: async (command) => puts.push(command.input || command)
    },
    logError: () => {}
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  currentNow = new Date("2026-08-11T03:30:00.000Z");
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(puts.length, 0);
  assert.equal(unlinks.length, 1);
});

test("signal handler flushes current window", async () => {
  const handlers = {};
  const puts = [];
  const files = new Map();
  const currentNow = new Date("2026-08-11T03:16:00.000Z");

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "my-bucket",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
    onSignal: (event, handler) => {
      handlers[event] = handler;
    },
    fs: {
      async mkdir() {},
      async appendFile(filePath, data) {
        files.set(filePath, (files.get(filePath) || "") + data);
      },
      async readFile(filePath) {
        return files.get(filePath) || "";
      },
      async unlink() {}
    },
    s3Client: {
      send: async (command) => {
        puts.push(command.input || command);
        return {};
      }
    },
    logError: () => {}
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof handlers.SIGTERM, "function");
  assert.equal(typeof handlers.SIGINT, "function");
  handlers.SIGTERM();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(puts.length, 1);
  assert.match(puts[0].Key, /0315-i-1\.ndjson$/);
});

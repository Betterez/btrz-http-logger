"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const fsp = require("node:fs").promises;
const fs = require("node:fs");
const {EventEmitter} = require("node:events");

const recorderPath = path.resolve(__dirname, "..", "src", "s3-request-recorder.js");
const indexPath = path.resolve(__dirname, "..", "index.js");

function loadRecorderModule({send} = {}) {
  const puts = [];
  const originalLoad = Module._load;
  const sendFn = send || (async (command) => {
    puts.push(command.input || command);
    return {};
  });

  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === "@aws-sdk/client-s3") {
      return {
        S3Client: class MockS3Client {
          send(command) {
            return sendFn(command);
          }
        },
        PutObjectCommand: class MockPutObjectCommand {
          constructor(input) {
            this.input = input;
          }
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[recorderPath];
    const mod = require("../src/s3-request-recorder");
    return {
      s3RequestRecorder: mod.s3RequestRecorder,
      buildS3Key: mod.buildS3Key,
      getWindowStart: mod.getWindowStart,
      puts
    };
  } finally {
    Module._load = originalLoad;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

function createMockRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

function noopOnSignal() {}

function createTestLogger() {
  const entries = [];
  return {
    entries,
    info(msg, data) {
      entries.push({level: "info", msg, data});
    },
    error(msg, data) {
      entries.push({level: "error", msg, data});
    },
    debug() {},
    fatal() {}
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "btrz-http-logger-"));
}

async function waitForFile(filePath, {timeoutMs = 1000} = {}) {
  const start = process.hrtime.bigint();
  while (process.hrtime.bigint() - start < BigInt(timeoutMs) * 1000000n) {
    try {
      const content = await fsp.readFile(filePath, "utf8");
      if (content.length > 0) {
        return content;
      }
    } catch (_err) {}
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`Timed out waiting for file ${filePath}`);
}

async function listNdjsonFiles(dir) {
  const names = await fsp.readdir(dir);
  return names.filter((name) => name.endsWith(".ndjson")).map((name) => path.join(dir, name));
}

async function waitForNdjsonFile(dir, {timeoutMs = 1000} = {}) {
  const start = process.hrtime.bigint();
  while (process.hrtime.bigint() - start < BigInt(timeoutMs) * 1000000n) {
    const files = await listNdjsonFiles(dir);
    if (files.length > 0) {
      await waitForFile(files[0], {timeoutMs: 200});
      return files[0];
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`Timed out waiting for ndjson in ${dir}`);
}

async function withFakeNowAsync(isoOrDate, fn) {
  const fixedMs = typeof isoOrDate === "number" ? isoOrDate : new Date(isoOrDate).getTime();
  let currentMs = fixedMs;
  const RealDate = Date;

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(currentMs);
      } else {
        super(...args);
      }
    }

    // Keep wall-clock now() so timeouts/polling still advance
    static now() {
      return RealDate.now();
    }
  }

  global.Date = FakeDate;
  try {
    return await fn({
      set(next) {
        currentMs = typeof next === "number" ? next : new RealDate(next).getTime();
      }
    });
  } finally {
    global.Date = RealDate;
  }
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
  const logger = createTestLogger();
  const mw = s3RequestRecorder({}, logger);
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].level, "error");
  assert.match(logger.entries[0].msg, /missing bucket/);
});

test("returns no-op middleware when bucket is empty string", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const logger = createTestLogger();
  const mw = s3RequestRecorder({
    bucket: ""
  }, logger);
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  mw({method: "POST", url: "/other"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 2);
  assert.equal(logger.entries.length, 1);
  assert.match(logger.entries[0].msg, /missing bucket/);
});

test("returns no-op middleware when logger is missing", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder({bucket: "b"});
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
});

test("calls next without waiting for append or upload", async () => {
  const appendStarted = createDeferred();
  const appendFinished = createDeferred();
  const putFinished = createDeferred();
  const calls = {next: 0, append: 0, put: 0};
  const tempDir = makeTempDir();
  const originalAppend = fsp.appendFile;

  fsp.appendFile = async (...args) => {
    calls.append += 1;
    appendStarted.resolve();
    await appendFinished.promise;
    return originalAppend.apply(fsp, args);
  };

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule({
        send: async () => {
          calls.put += 1;
          await putFinished.promise;
          return {};
        }
      });
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(200);
      mw(
        {
          method: "POST",
          url: "/v1/orders?foo=1",
          path: "/v1/orders",
          query: {foo: "1"},
          headers: {"x-api-key": "secret"},
          body: {a: 1}
        },
        res,
        () => {
          calls.next += 1;
        }
      );

      assert.equal(calls.next, 1);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.append, 0);
      res.emit("finish");
      await appendStarted.promise;
      assert.equal(calls.append, 1);
      assert.equal(calls.put, 0);
      appendFinished.resolve();
      await new Promise((r) => setImmediate(r));
    });
  } finally {
    fsp.appendFile = originalAppend;
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("writes NDJSON with method url headers query and body when present", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(200);
      mw(
        {
          method: "POST",
          url: "/v1/orders?foo=1",
          path: "/v1/orders",
          query: {foo: "1"},
          headers: {host: "example"},
          body: {a: 1}
        },
        res,
        () => {}
      );
      res.emit("finish");

      const filePath = await waitForNdjsonFile(tempDir);
      const content = await fsp.readFile(filePath, "utf8");
      const record = JSON.parse(content.trim().split("\n")[0]);
      assert.equal(record.method, "POST");
      assert.equal(record.url, "/v1/orders?foo=1");
      assert.equal(record.path, "/v1/orders");
      assert.deepEqual(record.query, {foo: "1"});
      assert.deepEqual(record.headers, {host: "example"});
      assert.deepEqual(record.body, {a: 1});
      assert.equal(record.ts, "2026-08-11T03:16:00.000Z");
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("parses query from url when req.query is missing", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(200);
      mw(
        {
          method: "GET",
          url: "/v1/orders?foo=1",
          path: "/v1/orders",
          headers: {}
        },
        res,
        () => {}
      );
      res.emit("finish");

      const filePath = await waitForNdjsonFile(tempDir);
      const content = await fsp.readFile(filePath, "utf8");
      const record = JSON.parse(content.trim().split("\n")[0]);
      assert.deepEqual(record.query, {foo: "1"});
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("parses query from originalUrl when req.query and url lack querystring", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(200);
      mw(
        {
          method: "GET",
          url: "/v1/orders",
          originalUrl: "/v1/orders?bar=2",
          path: "/v1/orders",
          headers: {}
        },
        res,
        () => {}
      );
      res.emit("finish");

      const filePath = await waitForNdjsonFile(tempDir);
      const content = await fsp.readFile(filePath, "utf8");
      const record = JSON.parse(content.trim().split("\n")[0]);
      assert.deepEqual(record.query, {bar: "2"});
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("omits body when req.body is undefined", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(200);
      mw(
        {
          method: "GET",
          url: "/",
          path: "/",
          query: {},
          headers: {}
        },
        res,
        () => {}
      );
      res.emit("finish");

      const filePath = await waitForNdjsonFile(tempDir);
      const content = await fsp.readFile(filePath, "utf8");
      const record = JSON.parse(content.trim().split("\n")[0]);
      assert.equal(Object.prototype.hasOwnProperty.call(record, "body"), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("calls next and omits body when req.body is circular", async () => {
  const tempDir = makeTempDir();
  const circular = {a: 1};
  circular.self = circular;

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      let nextCalled = 0;
      const res = createMockRes(200);
      mw(
        {
          method: "POST",
          url: "/",
          path: "/",
          query: {},
          headers: {},
          body: circular
        },
        res,
        () => {
          nextCalled += 1;
        }
      );

      assert.equal(nextCalled, 1);
      res.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);
      const content = await fsp.readFile(filePath, "utf8");
      const record = JSON.parse(content.trim().split("\n")[0]);
      assert.equal(record.method, "POST");
      assert.equal(Object.prototype.hasOwnProperty.call(record, "body"), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
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
  const appendDone = createDeferred();
  const tempDir = makeTempDir();
  const originalAppend = fsp.appendFile;
  const logger = createTestLogger();

  fsp.appendFile = async () => {
    appendDone.resolve();
    throw new Error("disk full");
  };

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, logger);

      let nextCalled = 0;
      const res = createMockRes(200);
      mw({method: "GET", url: "/", path: "/", query: {}, headers: {}}, res, () => {
        nextCalled += 1;
      });
      assert.equal(nextCalled, 1);
      res.emit("finish");
      await appendDone.promise;
      await new Promise((r) => setImmediate(r));
      assert.ok(logger.entries.some((e) => e.level === "error" && /append failed/.test(e.msg)));
    });
  } finally {
    fsp.appendFile = originalAppend;
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("flushes previous window to S3 and deletes temp file on success", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "my-bucket",
        prefix: "http-requests/sales",
        instanceId: "i-abc123",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const fileBefore = await waitForNdjsonFile(tempDir);

      clock.set("2026-08-11T03:30:00.000Z");
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(puts.length, 1);
      assert.equal(puts[0].Bucket, "my-bucket");
      assert.equal(puts[0].Key, "http-requests/sales/2026/08/11/0315-i-abc123.ndjson");
      assert.equal(puts[0].ContentType, "application/x-ndjson");
      assert.match(String(puts[0].Body), /"url":"\/a"/);
      assert.equal(fs.existsSync(fileBefore), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("on upload failure logs error and still deletes temp file", async () => {
  const tempDir = makeTempDir();
  const logger = createTestLogger();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder} = loadRecorderModule({
        send: async () => {
          throw new Error("S3 down");
        }
      });
      const mw = s3RequestRecorder({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, logger);

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const fileBefore = await waitForNdjsonFile(tempDir);

      clock.set("2026-08-11T03:30:00.000Z");
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(logger.entries.some((e) => e.level === "error" && (/upload failed/i.test(e.msg) || /S3 down/.test(String(e.data)))));
      assert.equal(fs.existsSync(fileBefore), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("next is called before flush upload resolves", async () => {
  const uploadGate = createDeferred();
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder} = loadRecorderModule({
        send: async () => uploadGate.promise
      });
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);

      clock.set("2026-08-11T03:30:00.000Z");
      let nextCalled = 0;
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {
        nextCalled += 1;
      });
      res2.emit("finish");
      assert.equal(nextCalled, 1);
      uploadGate.resolve({});
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("flush waits for an in-flight append before uploading", async () => {
  const appendStarted = createDeferred();
  const appendFinished = createDeferred();
  const tempDir = makeTempDir();
  const originalAppend = fsp.appendFile;

  fsp.appendFile = async (...args) => {
    appendStarted.resolve();
    await appendFinished.promise;
    return originalAppend.apply(fsp, args);
  };

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      await appendStarted.promise;
      clock.set("2026-08-11T03:30:00.000Z");
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(puts.length, 0);

      appendFinished.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(puts.length, 1);
    });
  } finally {
    fsp.appendFile = originalAppend;
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("skips S3 upload for an empty previous file but deletes it", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);
      await fsp.writeFile(filePath, "");

      clock.set("2026-08-11T03:30:00.000Z");
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(puts.length, 0);
      assert.equal(fs.existsSync(filePath), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("signal handler flushes current window", async () => {
  const handlers = {};
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();

      const mw = s3RequestRecorder({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }, createTestLogger());

      const res = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res, () => {});
      res.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);
      assert.equal(typeof handlers.SIGTERM, "function");
      assert.equal(typeof handlers.SIGINT, "function");
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(puts.length, 1);
      assert.match(puts[0].Key, /0315-i-1\.ndjson$/);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("signal flush waits for a new same-window request to finish", async () => {
  const handlers = {};
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);

      handlers.SIGTERM();
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(puts.length, 0, "must not flush while same-window request is pending");
      assert.equal(fs.existsSync(filePath), true);

      res2.emit("finish");
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(puts.length, 1);
      assert.match(String(puts[0].Body), /"url":"\/a"/);
      assert.match(String(puts[0].Body), /"url":"\/b"/);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("throwing response listener registration does not strand pending flush", async () => {
  const handlers = {};
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      await waitForNdjsonFile(tempDir);

      let nextCalled = 0;
      mw(
        {method: "GET", url: "/broken", path: "/broken", query: {}, headers: {}},
        {
          statusCode: 200,
          on() {
            throw new Error("listener registration failed");
          }
        },
        () => {
          nextCalled += 1;
        }
      );
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(nextCalled, 1);
      assert.equal(puts.length, 1);
      assert.doesNotMatch(String(puts[0].Body), /"url":"\/broken"/);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("records status and durationMs on finish without aborted", async () => {
  const tempDir = makeTempDir();
  const appendCalls = {count: 0};
  const originalAppend = fsp.appendFile;

  fsp.appendFile = async (...args) => {
    appendCalls.count += 1;
    return originalAppend.apply(fsp, args);
  };

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(201);
      mw(
        {method: "POST", url: "/x", path: "/x", query: {}, headers: {}},
        res,
        () => {}
      );

      await new Promise((r) => setImmediate(r));
      assert.equal(appendCalls.count, 0);
      const filesBefore = await listNdjsonFiles(tempDir);
      assert.equal(filesBefore.length, 0);

      clock.set("2026-08-11T03:16:00.050Z");
      res.emit("finish");

      const filePath = await waitForNdjsonFile(tempDir);
      const record = JSON.parse((await fsp.readFile(filePath, "utf8")).trim().split("\n")[0]);
      assert.equal(record.status, 201);
      assert.equal(record.durationMs, 50);
      assert.equal(Object.prototype.hasOwnProperty.call(record, "aborted"), false);
      assert.equal(record.ts, "2026-08-11T03:16:00.000Z");
    });
  } finally {
    fsp.appendFile = originalAppend;
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("records aborted true on close without finish", async () => {
  const tempDir = makeTempDir();
  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(200);
      mw(
        {method: "GET", url: "/slow", path: "/slow", query: {}, headers: {}},
        res,
        () => {}
      );
      clock.set("2026-08-11T03:16:01.200Z");
      res.emit("close");

      const filePath = await waitForNdjsonFile(tempDir);
      const record = JSON.parse((await fsp.readFile(filePath, "utf8")).trim().split("\n")[0]);
      assert.equal(record.status, 200);
      assert.equal(record.durationMs, 1200);
      assert.equal(record.aborted, true);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("writes only one line when finish and close both fire", async () => {
  const tempDir = makeTempDir();
  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res = createMockRes(204);
      mw(
        {method: "GET", url: "/", path: "/", query: {}, headers: {}},
        res,
        () => {}
      );
      res.emit("finish");
      res.emit("close");

      const filePath = await waitForNdjsonFile(tempDir);
      await new Promise((r) => setTimeout(r, 20));
      const lines = (await fsp.readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.equal(record.status, 204);
      assert.equal(Object.prototype.hasOwnProperty.call(record, "aborted"), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("defers flush of previous window until pending request finishes", async () => {
  const tempDir = makeTempDir();
  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async (clock) => {
      const {s3RequestRecorder, puts} = loadRecorderModule();
      const mw = s3RequestRecorder({
        bucket: "my-bucket",
        prefix: "http-requests/sales",
        instanceId: "i-abc123",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }, createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      // still open — do not finish yet

      clock.set("2026-08-11T03:30:00.000Z");
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await waitForNdjsonFile(tempDir);
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(puts.length, 0, "must not flush W1 while /a still pending");

      res1.emit("finish");
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(puts.length, 1);
      assert.equal(puts[0].Key, "http-requests/sales/2026/08/11/0315-i-abc123.ndjson");
      assert.match(String(puts[0].Body), /"url":"\/a"/);
      assert.match(String(puts[0].Body), /"status":200/);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

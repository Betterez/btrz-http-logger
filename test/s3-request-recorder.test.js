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

function loadRecorderModule({send, get} = {}) {
  const puts = [];
  const gets = [];
  const clientConfigs = [];
  const originalLoad = Module._load;
  const sendFn = send || (async () => ({}));
  const getFn = get || (async () => {
    const err = new Error("NoSuchKey");
    err.name = "NoSuchKey";
    throw err;
  });

  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === "@aws-sdk/client-s3") {
      return {
        S3Client: class MockS3Client {
          constructor(clientConfig) {
            MockS3Client.lastConfig = clientConfig;
            clientConfigs.push(clientConfig);
          }
          send(command) {
            if (command.constructor.name === "GetObjectCommand") {
              gets.push(command.input || command);
              return getFn(command);
            }
            puts.push(command.input || command);
            return sendFn(command);
          }
        },
        PutObjectCommand: class PutObjectCommand {
          constructor(input) {
            this.input = input;
          }
        },
        GetObjectCommand: class GetObjectCommand {
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
      puts,
      gets,
      clientConfigs
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

const TEST_AWS = {
  region: "us-east-1",
  credentials: {
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret"
  }
};

function recorderConfig(overrides = {}) {
  return Object.assign({
    region: TEST_AWS.region,
    credentials: TEST_AWS.credentials
  }, overrides);
}

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
  assert.match(logger.entries[0].msg, /missing bucket, region, or credentials/);
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
  assert.match(logger.entries[0].msg, /missing bucket, region, or credentials/);
});

test("returns no-op middleware when credentials are missing", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const logger = createTestLogger();
  const mw = s3RequestRecorder({
    bucket: "b",
    region: "us-east-1"
  }, logger);
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  assert.match(logger.entries[0].msg, /missing bucket, region, or credentials/);
});

test("returns no-op middleware when region is missing", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const logger = createTestLogger();
  const mw = s3RequestRecorder({
    bucket: "b",
    credentials: TEST_AWS.credentials
  }, logger);
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  assert.match(logger.entries[0].msg, /missing bucket, region, or credentials/);
});

test("returns no-op middleware when logger is missing", () => {
  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");
  const mw = s3RequestRecorder(recorderConfig({bucket: "b"}));
  let nextCalled = 0;
  mw({method: "GET", url: "/"}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
});

test("constructs S3Client with explicit credentials from config", () => {
  const {s3RequestRecorder, clientConfigs} = loadRecorderModule();
  s3RequestRecorder(recorderConfig({
    bucket: "b",
    region: "eu-west-1",
    credentials: {
      accessKeyId: "AKIAEXPLICIT",
      secretAccessKey: "explicit-secret",
      sessionToken: "token"
    },
    onSignal: noopOnSignal
  }), createTestLogger());

  assert.equal(clientConfigs.length, 1);
  assert.deepEqual(clientConfigs[0], {
    region: "eu-west-1",
    credentials: {
      accessKeyId: "AKIAEXPLICIT",
      secretAccessKey: "explicit-secret",
      sessionToken: "token"
    }
  });
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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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

test("snapshots request body before next mutates it", async () => {
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule();
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());
      const req = {
        method: "POST",
        url: "/v1/orders",
        path: "/v1/orders",
        query: {},
        headers: {},
        body: {state: "original"}
      };
      const res = createMockRes(200);

      mw(req, res, () => {
        req.body.state = "mutated";
      });
      res.emit("finish");

      const filePath = await waitForNdjsonFile(tempDir);
      const record = JSON.parse((await fsp.readFile(filePath, "utf8")).trim());
      assert.deepEqual(record.body, {state: "original"});
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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), logger);

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        prefix: "http-requests/sales",
        instanceId: "i-abc123",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), logger);

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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

      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), createTestLogger());

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

test("signal flush uploads appended data while an open request can record afterward", async () => {
  const handlers = {};
  const tempDir = makeTempDir();
  const uploads = [];

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule({
        get: async () => ({Body: uploads[uploads.length - 1].Body}),
        send: async (command) => {
          uploads.push(command.input);
          return {};
        }
      });
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);

      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(uploads.length, 1, "must flush already-appended data despite pending request");
      assert.match(String(uploads[0].Body), /"url":"\/a"/);
      assert.doesNotMatch(String(uploads[0].Body), /"url":"\/b"/);

      res2.emit("finish");
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(uploads.length, 2);
      assert.match(String(uploads[1].Body), /"url":"\/a"/);
      assert.match(String(uploads[1].Body), /"url":"\/b"/);
      assert.equal(fs.existsSync(filePath), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("skips GetObject on first upload and merges subsequent partial flush", async () => {
  const handlers = {};
  const uploads = [];
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder, gets} = loadRecorderModule({
        get: async () => ({Body: uploads[uploads.length - 1].Body}),
        send: async (command) => {
          uploads.push(command.input);
          return {};
        }
      });
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      await waitForNdjsonFile(tempDir);
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(uploads.length, 1);
      assert.equal(gets.length, 0);

      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await waitForNdjsonFile(tempDir);
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(gets.length, 1);
      assert.equal(uploads.length, 2);
      assert.match(String(uploads[1].Body), /"url":"\/a"/);
      assert.match(String(uploads[1].Body), /"url":"\/b"/);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("GetObject failure still puts sealed body and deletes it on success", async () => {
  const handlers = {};
  const uploads = [];
  const tempDir = makeTempDir();
  const logger = createTestLogger();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      let denyGet = false;
      const {s3RequestRecorder} = loadRecorderModule({
        get: async () => {
          if (denyGet) {
            throw new Error("AccessDenied");
          }
          return {Body: uploads[uploads.length - 1].Body};
        },
        send: async (command) => {
          uploads.push(command.input);
          return {};
        }
      });
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), logger);

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      await waitForNdjsonFile(tempDir);
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      denyGet = true;
      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await waitForNdjsonFile(tempDir);
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(uploads.length, 2);
      assert.doesNotMatch(String(uploads[1].Body), /"url":"\/a"/);
      assert.match(String(uploads[1].Body), /"url":"\/b"/);
      assert.ok(logger.entries.some((entry) => /GetObject failed/.test(entry.msg)));
      assert.equal((await fsp.readdir(tempDir)).some((name) => name.endsWith(".uploading")), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("preserves sealed file when GetObject and PutObject both fail", async () => {
  const handlers = {};
  const tempDir = makeTempDir();
  const logger = createTestLogger();
  let putCount = 0;

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule({
        get: async () => {
          throw new Error("AccessDenied");
        },
        send: async () => {
          putCount += 1;
          if (putCount > 1) {
            throw new Error("Put denied");
          }
          return {};
        }
      });
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), logger);

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      await waitForNdjsonFile(tempDir);
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await waitForNdjsonFile(tempDir);
      handlers.SIGTERM();
      await new Promise((r) => setTimeout(r, 30));

      const sealed = (await fsp.readdir(tempDir)).find((name) => name.endsWith(".uploading"));
      assert.ok(sealed, "sealed data must remain available for recovery");
      assert.match(await fsp.readFile(path.join(tempDir, sealed), "utf8"), /"url":"\/b"/);
      assert.ok(logger.entries.some((entry) => /preserved sealed temp file/.test(entry.msg)));
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("signal flush isolates a request that starts during sealed S3 send", async () => {
  const handlers = {};
  const sendStarted = createDeferred();
  const firstSendGate = createDeferred();
  const firstSendFinished = createDeferred();
  const secondSend = createDeferred();
  const uploads = [];
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule({
        get: async () => {
          if (uploads.length === 0) {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            throw err;
          }
          return {Body: uploads[uploads.length - 1].Body};
        },
        send: async (command) => {
          uploads.push(command.input);
          if (uploads.length === 1) {
            sendStarted.resolve();
            await firstSendGate.promise;
            firstSendFinished.resolve();
          } else {
            secondSend.resolve(command.input);
          }
          return {};
        }
      });
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);

      handlers.SIGTERM();
      await sendStarted.promise;

      const res2 = createMockRes(200);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      handlers.SIGTERM();
      firstSendGate.resolve();
      await firstSendFinished.promise;
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(uploads.length, 1);
      assert.equal(fs.existsSync(filePath), false, "pending request has not appended yet");

      res2.emit("finish");
      assert.match(await waitForFile(filePath), /"url":"\/b"/);
      const finalUpload = await secondSend.promise;

      assert.match(String(finalUpload.Body), /"url":"\/a"/);
      assert.match(String(finalUpload.Body), /"url":"\/b"/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(fs.existsSync(filePath), false);
    });
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
});

test("signal flush preserves a request that fully finalizes during sealed S3 send", async () => {
  const handlers = {};
  const sendStarted = createDeferred();
  const firstSendGate = createDeferred();
  const secondSend = createDeferred();
  const uploads = [];
  const tempDir = makeTempDir();

  try {
    await withFakeNowAsync("2026-08-11T03:16:00.000Z", async () => {
      const {s3RequestRecorder} = loadRecorderModule({
        get: async () => {
          if (uploads.length === 0) {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            throw err;
          }
          return {Body: uploads[uploads.length - 1].Body};
        },
        send: async (command) => {
          uploads.push(command.input);
          if (uploads.length === 1) {
            sendStarted.resolve();
            await firstSendGate.promise;
          } else {
            secondSend.resolve(command.input);
          }
          return {};
        }
      });
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), createTestLogger());

      const res1 = createMockRes(200);
      mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, res1, () => {});
      res1.emit("finish");
      const filePath = await waitForNdjsonFile(tempDir);

      handlers.SIGTERM();
      await sendStarted.promise;

      const res2 = createMockRes(201);
      mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, res2, () => {});
      res2.emit("finish");
      await waitForFile(filePath);

      firstSendGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(uploads.length, 1);
      assert.match(String(uploads[0].Body), /"url":"\/a"/);
      assert.doesNotMatch(String(uploads[0].Body), /"url":"\/b"/);
      assert.match(await waitForFile(filePath), /"url":"\/b"/);

      handlers.SIGTERM();
      const finalUpload = await secondSend.promise;

      assert.match(String(finalUpload.Body), /"url":"\/a"/);
      assert.match(String(finalUpload.Body), /"url":"\/b"/);
      assert.match(String(finalUpload.Body), /"status":201/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(fs.existsSync(filePath), false);
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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        instanceId: "i-1",
        windowMinutes: 15,
        tempDir,
        onSignal: (event, handler) => {
          handlers[event] = handler;
        }
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "b",
        instanceId: "i-1",
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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
      const mw = s3RequestRecorder(recorderConfig({
        bucket: "my-bucket",
        prefix: "http-requests/sales",
        instanceId: "i-abc123",
        windowMinutes: 15,
        tempDir,
        onSignal: noopOnSignal
      }), createTestLogger());

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

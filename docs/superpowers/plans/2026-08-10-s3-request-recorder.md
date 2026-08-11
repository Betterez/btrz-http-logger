# S3 Request Recorder Middleware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate Express middleware that records all HTTP requests (full payload) to windowed local NDJSON temp files and fire-and-forget uploads them to S3 without blocking or failing requests.

**Architecture:** New named export `s3RequestRecorder(config)` returns Express middleware. Each request schedules an async append to a per-window temp file and calls `next()` immediately. When a later request observes a new UTC window (or on SIGTERM/SIGINT), the previous file is uploaded via `PutObject` (fire-and-forget). After each upload attempt (success or failure), the temp file is deleted. No timers. Existing Morgan factory stays unchanged.

**Tech Stack:** Node.js (CommonJS), `node:test` / `node:assert/strict`, `@aws-sdk/client-s3`, `fs.promises`, Express-style `(req, res, next)` middleware.

## Global Constraints

- Never throw / never call `next(err)` from the middleware.
- Never await local append or S3 upload before `next()`.
- No `setInterval` / timers for flush.
- No header redaction; include `body` only when `req.body !== undefined`.
- Always delete temp file after upload attempt completes (log error on failure, then delete).
- TDD-first: failing test → implement → green → commit.
- Spec: `docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/s3-request-recorder.js` | Middleware factory, record build, window math, temp append, flush/upload/delete, signal handlers |
| `index.js` | Keep default Morgan export; attach `module.exports.s3RequestRecorder` |
| `package.json` | Add `@aws-sdk/client-s3` dependency |
| `test/s3-request-recorder.test.js` | Unit tests with injected `s3Client`, `fs`, `now`, `logError` |
| `test/index.test.js` | Unchanged (must still pass) |

**Internal helpers in `src/s3-request-recorder.js` (same file, YAGNI — no extra modules unless file grows unwieldy):**

- `getWindowStart(date, windowMinutes) → Date`
- `buildS3Key({prefix, windowStart, instanceId}) → string`
- `buildRecord(req, now) → object`
- `s3RequestRecorder(config) → middleware` (+ optional `_flushForTests` / returned handle only if tests need it; prefer observing via mocks)

**Injectable config for tests (in addition to public options):**

```js
{
  bucket, prefix, region, windowMinutes, instanceId, tempDir, s3Client,
  fs: { appendFile, readFile, unlink, mkdir }, // default fs.promises
  now: () => Date,                             // default () => new Date()
  logError: (err, msg) => void,                // default console.error
  onSignal: null                               // if provided, use instead of process.on for tests
}
```

---

### Task 1: No-op when `bucket` missing + named export stub

**Files:**
- Create: `src/s3-request-recorder.js`
- Create: `test/s3-request-recorder.test.js`
- Modify: `index.js` (attach named export)
- Modify: `package.json` (add dependency)

**Interfaces:**
- Produces: `function s3RequestRecorder(config = {}) → (req, res, next) => void`
- Produces: `require("btrz-http-logger").s3RequestRecorder` and destructurable named export via `module.exports.s3RequestRecorder`

- [ ] **Step 1: Add `@aws-sdk/client-s3` dependency**

```bash
npm install @aws-sdk/client-s3@3 --save
```

- [ ] **Step 2: Write failing tests for missing bucket + export**

Create `test/s3-request-recorder.test.js`:

```js
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
```

If `warn` is not part of public API, use a one-time `logError`/`console.warn` spy via injectable `warn` — implement `warn` as optional injectable defaulting to `console.warn`.

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: FAIL (module/export missing).

- [ ] **Step 4: Minimal implementation**

`src/s3-request-recorder.js`:

```js
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
```

`index.js` — after the existing `module.exports = function _default...`, add:

```js
const {s3RequestRecorder} = require("./src/s3-request-recorder");
module.exports.s3RequestRecorder = s3RequestRecorder;
```

Note: because `module.exports` is assigned a function, set the property **after** that assignment:

```js
module.exports = function _default(app, stream, name, config = {}) {
  // ... existing body unchanged ...
};

module.exports.s3RequestRecorder = require("./src/s3-request-recorder").s3RequestRecorder;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests PASS (including existing Morgan tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/s3-request-recorder.js test/s3-request-recorder.test.js index.js
git commit -m "feat: add s3RequestRecorder export with no-op when bucket missing"
```

---

### Task 2: Build record + non-blocking append + never-fail `next()`

**Files:**
- Modify: `src/s3-request-recorder.js`
- Modify: `test/s3-request-recorder.test.js`

**Interfaces:**
- Consumes: `s3RequestRecorder(config)` from Task 1
- Produces: async append via `config.fs.appendFile(filePath, line, "utf8")` scheduled before `next()`; record fields `ts`, `method`, `url`, `path`, `query`, `headers`, optional `body`

- [ ] **Step 1: Write failing tests**

Append to `test/s3-request-recorder.test.js`:

```js
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: FAIL on missing append behavior.

- [ ] **Step 3: Implement record + async append**

In `src/s3-request-recorder.js`, implement approximately:

```js
"use strict";

const os = require("os");
const path = require("path");
const fsp = require("fs").promises;
const {S3Client, PutObjectCommand} = require("@aws-sdk/client-s3");

function buildRecord(req, now) {
  const record = {
    ts: now.toISOString(),
    method: req.method,
    url: req.url || req.originalUrl || "",
    path: req.path || (req.url || "").split("?")[0] || "",
    query: req.query && typeof req.query === "object" ? req.query : {},
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

  const bucket = config.bucket;
  const prefix = config.prefix || "";
  const windowMinutes = config.windowMinutes == null ? 15 : config.windowMinutes;
  const instanceId = config.instanceId || `${os.hostname()}-${process.pid}`;
  const tempDir = config.tempDir || os.tmpdir();
  const s3Client = config.s3Client || new S3Client(config.region ? {region: config.region} : {});

  let activeWindowStartMs = null;
  let activeTempPath = null;
  const inFlightAppends = new Map(); // path -> Promise

  function trackAppend(filePath, promise) {
    const prev = inFlightAppends.get(filePath) || Promise.resolve();
    const next = prev.then(() => promise).catch(() => {}).then(() => {
      if (inFlightAppends.get(filePath) === next) {
        inFlightAppends.delete(filePath);
      }
    });
    inFlightAppends.set(filePath, next);
    return next;
  }

  // getWindowStart / temp path / flush filled in Task 3–4; for now single file:
  function ensureTempPath(windowStart) {
    const stamp = windowStart.toISOString().replace(/[:.]/g, "-");
    return path.join(tempDir, `btrz-http-logger-${instanceId}-${stamp}.ndjson`);
  }

  function getWindowStart(date) {
    const d = new Date(date.getTime());
    d.setUTCSeconds(0, 0);
    const mins = d.getUTCMinutes();
    d.setUTCMinutes(mins - (mins % windowMinutes));
    return d;
  }

  return function s3RequestRecorderMiddleware(req, res, next) {
    try {
      const now = nowFn();
      const windowStart = getWindowStart(now);
      // window roll flush added in Task 4
      if (activeWindowStartMs !== windowStart.getTime()) {
        activeWindowStartMs = windowStart.getTime();
        activeTempPath = ensureTempPath(windowStart);
      }

      const line = serializeRecord(buildRecord(req, now));
      const filePath = activeTempPath;
      const appendPromise = Promise.resolve()
        .then(() => fs.mkdir(tempDir, {recursive: true}))
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .catch((err) => {
          logError(err, "[btrz-http-logger] s3RequestRecorder append failed");
        });
      trackAppend(filePath, appendPromise);
    } catch (err) {
      try {
        logError(err, "[btrz-http-logger] s3RequestRecorder record failed");
      } catch (_err) {}
    }
    next();
  };
}

module.exports = {s3RequestRecorder, buildRecord, getWindowStart: null};
```

Export `buildRecord` only if tests import it; otherwise keep private. Prefer testing via middleware behavior only (as in Step 1 tests). Remove unused exports — do not export `getWindowStart: null`.

Fix: do not export private helpers unless needed. Keep `module.exports = {s3RequestRecorder}` only.

Also implement `getWindowStart` inside the factory (close over `windowMinutes`) as shown.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: PASS for Task 2 tests (Task 1 tests still PASS).

- [ ] **Step 5: Commit**

```bash
git add src/s3-request-recorder.js test/s3-request-recorder.test.js
git commit -m "feat: record requests to temp NDJSON without blocking next()"
```

---

### Task 3: S3 key builder (UTC window)

**Files:**
- Modify: `src/s3-request-recorder.js`
- Modify: `test/s3-request-recorder.test.js`

**Interfaces:**
- Produces: `buildS3Key({prefix, windowStart, instanceId}) → string`  
  Format: `{prefix}/{yyyy}/{MM}/{dd}/{HHmm}-{instanceId}.ndjson` (UTC; empty prefix omits leading slash)

- [ ] **Step 1: Write failing tests**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: FAIL — `buildS3Key` not exported.

- [ ] **Step 3: Implement `buildS3Key` and `getWindowStart`**

```js
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

module.exports = {s3RequestRecorder, buildS3Key, getWindowStart};
```

Use shared `getWindowStart(date, windowMinutes)` from the factory instead of duplicating.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/s3-request-recorder.js test/s3-request-recorder.test.js
git commit -m "feat: add UTC window S3 key builder for request recorder"
```

---

### Task 4: Flush on window roll — upload, log errors, always delete temp file

**Files:**
- Modify: `src/s3-request-recorder.js`
- Modify: `test/s3-request-recorder.test.js`

**Interfaces:**
- Consumes: `buildS3Key`, `getWindowStart`, in-flight append tracking
- Produces: on window change, fire-and-forget flush that:
  1. awaits in-flight appends for the previous file
  2. `readFile` previous temp
  3. `s3Client.send(new PutObjectCommand({Bucket, Key, Body, ContentType: "application/x-ndjson"}))`
  4. on failure: `logError`
  5. always `unlink` previous temp (best-effort)
  6. never blocks `next()`

- [ ] **Step 1: Write failing tests**

```js
test("flushes previous window to S3 and deletes temp file on success", async () => {
  const files = new Map();
  const puts = [];
  const unlinks = [];
  let appendCount = 0;

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "my-bucket",
    prefix: "http-requests/sales",
    instanceId: "i-abc123",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => {
      // first two calls in first request path use T1; second request uses T2
      appendCount += 1;
      if (appendCount <= 2) {
        // buildRecord now + getWindowStart now roughly 2 now() calls — keep stable per request via closure below
      }
      return currentNow;
    },
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
      send: async (command) => {
        puts.push(command.input || command);
        return {};
      }
    },
    logError: () => {}
  });

  // Prefer a clearer clock: mutate `currentNow` between requests.
});
```

Use this clearer version instead:

```js
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
  await new Promise((r) => setImmediate(r));

  currentNow = new Date("2026-08-11T03:30:00.000Z");
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {});

  // allow flush promise chain
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(puts.length, 1);
  const put = puts[0];
  assert.equal(put.Bucket, "my-bucket");
  assert.equal(put.Key, "http-requests/sales/2026/08/11/0315-i-abc123.ndjson");
  assert.match(String(put.Body), /"url":"\/a"/);
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
  await new Promise((r) => setImmediate(r));
  currentNow = new Date("2026-08-11T03:30:00.000Z");
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {});
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(errors.some((e) => /S3|upload/i.test(String(e.msg)) || /S3 down/.test(String(e.err))));
  assert.equal(unlinks.length, 1);
});

test("next is called before flush upload resolves", async () => {
  const uploadGate = createDeferred();
  let currentNow = new Date("2026-08-11T03:16:00.000Z");
  const files = new Map();

  delete require.cache[recorderPath];
  const {s3RequestRecorder} = require("../src/s3-request-recorder");

  const mw = s3RequestRecorder({
    bucket: "b",
    instanceId: "i-1",
    windowMinutes: 15,
    tempDir: "/tmp/btrz-s3-rec",
    now: () => currentNow,
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
      send: async () => {
        await uploadGate.promise;
        return {};
      }
    },
    logError: () => {}
  });

  mw({method: "GET", url: "/a", path: "/a", query: {}, headers: {}}, {}, () => {});
  await new Promise((r) => setImmediate(r));
  currentNow = new Date("2026-08-11T03:30:00.000Z");

  let nextCalled = 0;
  mw({method: "GET", url: "/b", path: "/b", query: {}, headers: {}}, {}, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  uploadGate.resolve();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: FAIL — no PutObject / unlink on window change.

- [ ] **Step 3: Implement flush**

Add inside factory:

```js
function flushFile(filePath, windowStart) {
  const work = Promise.resolve()
    .then(() => inFlightAppends.get(filePath) || Promise.resolve())
    .then(() => fs.readFile(filePath))
    .then((body) => {
      const Key = buildS3Key({prefix, windowStart, instanceId});
      return s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key,
          Body: body,
          ContentType: "application/x-ndjson"
        })
      );
    })
    .catch((err) => {
      logError(err, "[btrz-http-logger] s3RequestRecorder S3 upload failed");
    })
    .finally(() => {
      return fs.unlink(filePath).catch((err) => {
        logError(err, "[btrz-http-logger] s3RequestRecorder temp delete failed");
      });
    });

  // fire-and-forget
  work.catch(() => {});
}

// In middleware, before switching active window:
if (activeWindowStartMs !== null && activeWindowStartMs !== windowStart.getTime()) {
  const previousPath = activeTempPath;
  const previousWindowStart = new Date(activeWindowStartMs);
  flushFile(previousPath, previousWindowStart);
}
activeWindowStartMs = windowStart.getTime();
activeTempPath = ensureTempPath(windowStart);
```

Skip flush when previous file had no successful path / empty — still OK to attempt read; on ENOENT log and skip upload but do not throw. If `readFile` throws ENOENT, catch in upload chain, log, and still attempt unlink (unlink may also ENOENT — ignore).

Refine empty-file behavior: if body is empty string, still upload or skip upload but still unlink — either is fine; prefer skip PutObject when body length is 0, then unlink.

```js
.then((body) => {
  if (!body || !body.length) {
    return null;
  }
  const Key = buildS3Key({prefix, windowStart, instanceId});
  return s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key,
    Body: body,
    ContentType: "application/x-ndjson"
  }));
})
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/s3-request-recorder.js test/s3-request-recorder.test.js
git commit -m "feat: flush windowed request logs to S3 and delete temp files"
```

---

### Task 5: Best-effort flush on SIGTERM / SIGINT

**Files:**
- Modify: `src/s3-request-recorder.js`
- Modify: `test/s3-request-recorder.test.js`

**Interfaces:**
- Produces: registers `process.on("SIGTERM", handler)` and `process.on("SIGINT", handler)` unless `config.onSignal(event, handler)` is provided for tests
- Handler fire-and-forget flushes current active temp file (same `flushFile` path)
- Handlers must not throw

- [ ] **Step 1: Write failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: FAIL — no signal registration.

- [ ] **Step 3: Implement signal registration**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add src/s3-request-recorder.js test/s3-request-recorder.test.js
git commit -m "feat: flush S3 request recorder on process signals"
```

---

### Task 6: Final verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md` (status → Implemented)
- Verify: `package.json` has `@aws-sdk/client-s3`

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests PASS; no ESLint config in this repo — skip ESLint unless present.

- [ ] **Step 2: Manual sanity checklist (read-only)**

Confirm against spec:

1. Separate middleware export (not Morgan factory config)
2. Non-blocking append + upload
3. No setInterval
4. Delete temp on upload success and failure
5. Body omitted when undefined
6. Headers not redacted
7. `windowMinutes` default 15

- [ ] **Step 3: Update spec status**

Set `**Status:** Implemented` in the design doc.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md
git commit -m "docs: mark S3 request recorder design implemented"
```

---

## Self-Review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Separate named export middleware | Task 1 |
| Missing bucket → no-op + warning | Task 1 |
| Record method/url/path/query/headers/body | Task 2 |
| Body only if `req.body !== undefined` | Task 2 |
| Async non-blocking append; `next()` always | Task 2 |
| JSON stringify failure omits body | Task 2 (`serializeRecord`) |
| `windowMinutes` default 15, UTC floor | Tasks 2–3 |
| S3 key `{prefix}/{yyyy}/{MM}/{dd}/{HHmm}-{instanceId}.ndjson` | Task 3 |
| Flush on window roll (no timer) | Task 4 |
| Fire-and-forget PutObject | Task 4 |
| Log upload error + always delete temp | Task 4 |
| Wait in-flight appends before upload | Task 4 |
| SIGTERM/SIGINT best-effort flush | Task 5 |
| `@aws-sdk/client-s3` dependency | Task 1 |
| Morgan factory unchanged / tests still pass | Tasks 1, 6 |
| TDD-first | All tasks |

No placeholders remain after inline fixes. Types/names consistent: `s3RequestRecorder`, `buildS3Key`, `getWindowStart`, injectable `fs` / `now` / `s3Client` / `logError` / `onSignal` / `warn`.

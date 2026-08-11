# S3 Request Recorder Status + Duration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `s3RequestRecorder` so each NDJSON line is written after the response ends and includes `status`, `durationMs`, and optional `aborted`, without blocking `next()` or flushing a window file while requests for that window are still open.

**Architecture:** On middleware entry, roll/select the request-start window, snapshot `tempPath` + request record + `startMs`, register one-shot `finish`/`close` listeners on `res`, then call `next()` with no append. On first terminal event, finalize the record and `trackAppend` to the snapshotted path. Track `pendingFinalizers` per temp path so window flush waits until those requests finalize.

**Tech Stack:** Node.js CommonJS, `node:test` / `node:assert/strict`, `events.EventEmitter` for test `res`, real `fs.promises`, FakeDate helper already in tests, `@aws-sdk/client-s3` (mocked via `Module._load`).

## Global Constraints

- Never throw / never call `next(err)`.
- Never await append or S3 before `next()`.
- No `setInterval`.
- Keep public API `s3RequestRecorder(config, logger)` unchanged.
- `ts` and S3 window from **request start**; append deferred to response end.
- `status` + `durationMs` always on written records; `aborted: true` only on `close` without prior `finish`.
- Do not upload+delete a temp path while `pendingFinalizers` for that path is &gt; 0.
- TDD-first; Spec: `docs/superpowers/specs/2026-08-11-s3-recorder-status-duration-design.md`.
- Duration timing: use `new Date().getTime()` for start and end (not `Date.now()`), so FakeDate `clock.set` in tests controls `durationMs`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/s3-request-recorder.js` | Defer append; finish/close listeners; pendingFinalizers + flushWhenIdle |
| `test/s3-request-recorder.test.js` | `createMockRes` helper; update existing tests to emit finish; new status/abort/flush-idle tests |
| `docs/superpowers/specs/2026-08-11-s3-recorder-status-duration-design.md` | Status → Implemented when done |
| `docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md` | Already cross-linked; no further change required unless record-shape section should mention status (optional note in Task 4) |

No new source modules.

---

### Task 1: Mock `res` helper + failing tests for status/duration/aborted + update existing append tests

**Files:**
- Modify: `test/s3-request-recorder.test.js`

**Interfaces:**
- Produces: `createMockRes(statusCode = 200) → EventEmitter` with `statusCode`, usable as Express `res` (`on`/`emit`/`once`)
- Produces: failing tests that define the new behavior (implementation in Task 2–3)

- [ ] **Step 1: Add `createMockRes` near other test helpers**

```js
const {EventEmitter} = require("node:events");

function createMockRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}
```

- [ ] **Step 2: Update every existing test that expects an NDJSON append to pass `createMockRes(...)` and emit `finish` after `next()`**

Pattern for tests that currently pass `{}` as `res` and then `waitForNdjsonFile` / spy `appendFile`:

```js
const res = createMockRes(200);
mw(req, res, () => { /* next */ });
// assert next already called, and append has NOT started yet when testing that
res.emit("finish");
// then wait for file / appendStarted
```

Specifically update at least:

- `calls next without waiting for append or upload` — assert `calls.next === 1` and `calls.append === 0` **before** `finish`; then `res.emit("finish")`; then await `appendStarted`.
- `writes NDJSON with method url headers query and body when present`
- `parses query from url when req.query is missing`
- `parses query from originalUrl when req.query and url lack querystring`
- `omits body when req.body is undefined`
- `calls next even when append fails asynchronously` — emit `finish` after next so append runs
- window flush tests (`flushes previous window…`, upload failure, next before flush, empty body skip, signal handler) — each request’s `res` must `emit("finish")` (and await a tick) before advancing the clock / rolling the window, otherwise deferred append never writes and flush sees empty/missing body

No-op middleware tests may keep `{}` as `res` (they never register listeners once implemented, and today they ignore `res`).

- [ ] **Step 3: Add new failing tests**

Append to `test/s3-request-recorder.test.js`:

```js
test("records status and durationMs on finish without aborted", async () => {
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

      const res = createMockRes(201);
      mw(
        {method: "POST", url: "/x", path: "/x", query: {}, headers: {}},
        res,
        () => {}
      );

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
```

- [ ] **Step 4: Run tests to verify new behavior fails (and updated append tests fail until Task 2)**

```bash
cd /Users/hernangarcia/Projects/betterez/btrz-http-logger && npm test -- test/s3-request-recorder.test.js
```

Expected: FAIL — append still happens before `finish`, or new assertions on `status` / deferred flush fail.

- [ ] **Step 5: Commit test-only changes**

```bash
git add test/s3-request-recorder.test.js
git commit -m "test: expect deferred S3 recorder append with status and duration"
```

---

### Task 2: Defer append until finish/close; add status, durationMs, aborted

**Files:**
- Modify: `src/s3-request-recorder.js` (middleware body ~208–226; keep helpers)
- Test: `test/s3-request-recorder.test.js` (from Task 1)

**Interfaces:**
- Consumes: `buildRecord(req, now)`, `serializeRecord`, `trackAppend`, window roll / `ensureTempPath`
- Produces: middleware that appends only from one-shot `finish`/`close` finalizer with fields `status`, `durationMs`, optional `aborted`

- [ ] **Step 1: Replace middleware request path to snapshot + listen (keep immediate flush-on-roll for now — Task 3 fixes pending)**

Replace the middleware function body with logic equivalent to:

```js
return function s3RequestRecorderMiddleware(req, res, next) {
  try {
    const now = new Date();
    const startMs = now.getTime();
    const windowStart = getWindowStart(now, windowMinutes);
    if (activeWindowStartMs !== windowStart.getTime()) {
      if (activeWindowStartMs !== null) {
        flushFile(activeTempPath, new Date(activeWindowStartMs));
      }
      activeWindowStartMs = windowStart.getTime();
      activeTempPath = ensureTempPath(windowStart);
    }

    const tempPath = activeTempPath;
    const windowStartMsForRequest = activeWindowStartMs;
    const record = buildRecord(req, now);
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
      }
    }

    if (res && typeof res.on === "function") {
      res.on("finish", () => finalize(false));
      res.on("close", () => {
        if (!finalized) {
          finalize(true);
        }
      });
    } else {
      // No usable res — do not append (tests and Express always pass a real res)
    }
  } catch (err) {
    safelyLog(logger, "error", "[btrz-http-logger] s3RequestRecorder record failed", err);
  }
  next();
};
```

Notes for the implementer:

- Prefer `res.on` with an internal `finalized` guard (not `res.once` alone) so `close` after `finish` is a no-op.
- Do not append on the entry path.
- Leave `pendingFinalizers` for Task 3; Task 1’s flush-idle test will still fail after this task.

- [ ] **Step 2: Run focused tests**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: status/duration/aborted/one-line tests PASS; `defers flush of previous window until pending request finishes` still FAIL; other updated flush tests PASS if they finish requests before rolling.

- [ ] **Step 3: Commit**

```bash
git add src/s3-request-recorder.js test/s3-request-recorder.test.js
git commit -m "feat: record response status and duration after request finish"
```

---

### Task 3: pendingFinalizers + flushWhenIdle

**Files:**
- Modify: `src/s3-request-recorder.js`
- Test: `test/s3-request-recorder.test.js` (`defers flush…` from Task 1)

**Interfaces:**
- Consumes: `flushFile(filePath, windowStart)`, `trackAppend`
- Produces: per-path `pendingFinalizers` count; `flushWhenIdle` set; `scheduleFlush(filePath, windowStart)` that flushes immediately only when pending is 0

- [ ] **Step 1: Add pending tracking state next to `inFlightAppends`**

```js
const pendingFinalizers = new Map(); // filePath -> number
const flushWhenIdle = new Map(); // filePath -> windowStart Date
const windowStartByPath = new Map(); // filePath -> windowStart Date (for idle flush)
```

- [ ] **Step 2: Implement helpers**

```js
function bumpPending(filePath) {
  pendingFinalizers.set(filePath, (pendingFinalizers.get(filePath) || 0) + 1);
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
```

- [ ] **Step 3: Wire into middleware and window roll**

On successful snapshot (before registering listeners):

```js
bumpPending(tempPath);
windowStartByPath.set(tempPath, new Date(windowStartMsForRequest));
```

On window roll, replace direct `flushFile(...)` with:

```js
scheduleFlush(activeTempPath, new Date(activeWindowStartMs));
```

In `finalize`, after `trackAppend(...)` (and in the catch path too), always:

```js
releasePending(tempPath);
```

If listener registration is skipped because `res` has no `on`, call `releasePending(tempPath)` immediately so counts do not leak.

Update `flushActive` (signals) to use `scheduleFlush` instead of unconditional `flushFile`, so SIGTERM does not delete a path that still has pending finalizers. If pending &gt; 0, mark `flushWhenIdle` and clear `activeTempPath` / `activeWindowStartMs` the same way; when the last request finalizes, idle flush runs.

- [ ] **Step 4: Run tests**

```bash
npm test -- test/s3-request-recorder.test.js
```

Expected: all recorder tests PASS, including `defers flush of previous window until pending request finishes`.

- [ ] **Step 5: Commit**

```bash
git add src/s3-request-recorder.js
git commit -m "fix: delay S3 recorder window flush while requests pending"
```

---

### Task 4: Full suite + mark design implemented

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-s3-recorder-status-duration-design.md` (status line)
- Optional: add `status` / `durationMs` to the record-shape example in `docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md`

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests PASS (recorder + Morgan `test/index.test.js`).

- [ ] **Step 2: Update design status**

In `docs/superpowers/specs/2026-08-11-s3-recorder-status-duration-design.md`:

```markdown
**Status:** Implemented
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-11-s3-recorder-status-duration-design.md docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md
git commit -m "docs: mark S3 recorder status/duration design implemented"
```

---

## Self-Review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Defer append until finish/close | Task 2 |
| `status` + `durationMs` on written records | Tasks 1–2 |
| `aborted` only on close without finish | Tasks 1–2 |
| One-shot / single line if both events | Tasks 1–2 |
| `ts` + window from request start | Task 2 (snapshot path) |
| No remount later required | Task 2 (`res.on`) |
| Never block `next()` | Tasks 1–2 |
| pendingFinalizers / flushWhenIdle | Task 3 |
| Existing never-fail / upload+delete / signals | Tasks 2–3 (signals via `scheduleFlush`) |
| TDD | All tasks |
| No response body/headers / API unchanged | Out of scope — not implemented |

No placeholders remain after inline review. Names consistent: `createMockRes`, `pendingFinalizers`, `flushWhenIdle`, `scheduleFlush`, `releasePending`, `bumpPending`, fields `status` / `durationMs` / `aborted`.

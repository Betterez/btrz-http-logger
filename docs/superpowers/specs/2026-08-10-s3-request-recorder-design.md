# S3 Request Recorder Middleware — Design

**Date:** 2026-08-10  
**Repo:** `btrz-http-logger`  
**Status:** Implemented

## Goal

Add a **separate** Express middleware that records every HTTP request (all verbs) with the complete request payload and uploads windowed NDJSON files to an S3 bucket.

Constraints:

1. The middleware must **never fail** the HTTP request (no thrown errors, never call `next(err)`).
2. **Local file append and S3 upload are both asynchronous and non-blocking** — the request path must call `next()` without waiting for disk I/O or upload completion.
3. Implementation must be **TDD-first**: write failing tests, then implement until green.

## Non-goals

- Not wired into the existing Morgan request/response factory (`module.exports = function (app, stream, name, config)`).
- No response body / status recording.
- No header redaction.
- No cross-instance merging of S3 objects.
- No raw stream body buffering (does not replace body-parser).

## Public API

Named export alongside the existing default export:

```js
const httpLogger = require("btrz-http-logger");
// httpLogger === existing Morgan factory (unchanged)
// httpLogger.s3RequestRecorder === new middleware factory

const {s3RequestRecorder} = require("btrz-http-logger");

app.use(s3RequestRecorder({
  bucket: "my-bucket",              // required; missing → no-op middleware
  prefix: "http-requests/my-service", // optional
  region: "us-east-1",              // optional (AWS default chain)
  windowMinutes: 15,                // optional, default 15
  instanceId: "i-abc",              // optional; fallback hostname + pid
  tempDir: undefined                // optional; default os.tmpdir()
}, logger)); // required; btrz-logger instance (`info` / `error` / …)
```

Signature: `s3RequestRecorder(config, logger)`.

### Config rules

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `bucket` | yes | — | If missing/empty, return no-op middleware that only calls `next()`, with a one-time `logger.error` |
| `prefix` | no | `""` | Leading/trailing slashes normalized when building keys |
| `region` | no | SDK default | Passed to `@aws-sdk/client-s3` when creating client |
| `windowMinutes` | no | `15` | S3 key partition size; flush happens when a later request observes a new window (no timer) |
| `instanceId` | no | `hostname-pid` | Used in S3 object key |
| `tempDir` | no | `os.tmpdir()` | Local NDJSON buffer directory |

| Argument | Required | Notes |
|----------|----------|-------|
| `logger` | yes | Second argument: `btrz-logger` `Logger` instance. Uses `logger.error(msg)` / `logger.error(msg, err)`. Missing logger → silent no-op |

Do **not** inject `fs`, `now`, `warn`, `logError`, or `logger` via config. Always use `fs.promises` and `new Date()`. Logging goes through the `logger` argument.

Credentials use the default AWS SDK credential chain (or an optional test-only `s3Client` if provided by the consumer for tests).

## Request path behavior

For every request (all HTTP methods):

1. Synchronously build/serialize a record object in memory (cheap; keep work minimal).
2. Schedule a best-effort async append of one NDJSON line to the current window’s local temp file (e.g. `fs.promises.appendFile` / `fs.appendFile` callback) — **do not await it**.
3. Call `next()` immediately after scheduling.
4. Never await local append or S3 upload on this path.

Any error during serialize is caught before `next()`; append failures are handled in the async callback (optional stderr log). `next()` always runs and is never delayed by disk I/O.

### Record shape

```json
{
  "ts": "2026-08-11T03:15:22.123Z",
  "method": "POST",
  "url": "/v1/orders?foo=1",
  "path": "/v1/orders",
  "query": { "foo": "1" },
  "headers": { "...": "as received" },
  "body": { "...": "..." }
}
```

- `headers`: exact `req.headers` (no redaction).
- `query`: `req.query` when present, else parsed from URL / empty object.
- `body`: included **only** when `req.body !== undefined`; otherwise omit the field.
- If `JSON.stringify` fails (e.g. circular body): omit `body` and still write the rest of the record; never fail the request.

## Temp file, window, and S3 upload

### Local buffer

- One temp file per active window under `tempDir`.
- Filename is internal/implementation detail (must be unique per process + window).
- Append is async and best-effort (`fs.appendFile` / `fs.promises.appendFile`); the middleware must not use `appendFileSync` or otherwise block the event loop waiting for the write to finish.
- Concurrent appends to the same file are acceptable (Node’s append is atomic per write for typical line sizes); ordering of lines within a window is best-effort, not strictly request-order guaranteed under concurrency.

### Window = partition + flush

- `windowMinutes` (default 15) defines the S3 key time partition and when a new temp file is started. Upload of the previous file is triggered when a request observes that the window has rolled (or on shutdown).
- Window start is computed in UTC by flooring the current time to `windowMinutes` (e.g. with 15: `03:00`, `03:15`, `03:30`, `03:45`).
- **No `setInterval` / timers.** Flush is event-driven only:
  1. **On request, window rolled:** if the computed window start differs from the active window, fire-and-forget upload the previous temp file via `PutObject`, then schedule append of the new record to a new temp file for the current window.
  2. **On `SIGTERM` / `SIGINT`:** best-effort flush of the current window (still non-throwing; not awaited by request handlers).
- Trade-off: if traffic stops inside a window, that window’s file uploads on the next request after the window rolls, or on process shutdown — not on a timer.
- **Always delete the local temp file after an upload attempt completes** (success or failure), so disk does not fill up. On failure: log the error, then delete. Deletion is best-effort (delete errors logged, never thrown). No retry / pending-upload list.

### S3 object key

```text
{prefix}/{yyyy}/{MM}/{dd}/{HHmm}-{instanceId}.ndjson
```

Example: `http-requests/sales/2026/08/11/0315-i-abc123.ndjson`

- Times in UTC.
- `{HHmm}` is the window start (floored to `windowMinutes`).
- One object per **instance** per window (no shared key across processes).
- Upload sends the full temp file contents for that window (`PutObject` overwrite of that instance key).

### Async / never-fail I/O

- Local append and S3 upload are both started as Promises/callbacks that are **not** awaited on the request path.
- Rejected appends/uploads are caught and logged; never rethrown to Express.
- Request latency must not include disk append time or S3 round-trip time.
- Before uploading a window file, wait for in-flight appends for that file to settle (internal tracking), so the uploaded object is not truncated — this coordination happens only on the flush path, never on `next()`.
- After the upload attempt finishes (resolve or reject), delete the temp file; on reject, log first, then delete.

## Module layout

```text
index.js                         # existing Morgan factory (default export) + attach named export
src/s3-request-recorder.js       # middleware factory + window/temp/upload orchestration
test/s3-request-recorder.test.js # TDD unit tests (mocked fs + S3)
```

Dependency: `@aws-sdk/client-s3`.

Existing Morgan behavior and tests remain unchanged.

## Failure matrix

| Failure | Request impact |
|---------|----------------|
| Missing `bucket` or missing `logger` argument | No-op middleware; `next()` only (`logger.error` once if logger present but bucket missing) |
| Temp dir / append failure | `logger.error` asynchronously; `next()` already called |
| Body / JSON serialize failure | Record without `body`; `next()` |
| S3 `PutObject` failure | `logger.error` asynchronously; delete temp file anyway; request already continued |
| Temp file delete after upload attempt | `logger.error` if delete fails; request unaffected |
| Unexpected throw in middleware | Catch; `logger.error`; `next()` |

## Testing strategy (TDD-first)

Implementation order is strictly:

1. Add failing unit tests in `test/s3-request-recorder.test.js`.
2. Implement the minimum code to pass.
3. Refactor while keeping tests green.

### Required test cases

1. Calls `next()` even when append fails (async failure after `next()`).
2. Calls `next()` without waiting for local append or S3 upload to resolve.
3. Writes NDJSON including method, url, headers, query.
4. Includes `body` only when `req.body` is present.
5. Builds S3 key from window start + `instanceId` (UTC).
6. Flushes/uploads on window boundary.
7. Deletes the local temp file after upload attempt completes (success or failure); on failure, error is logged.
8. Returns no-op when `bucket` is missing.
9. Existing Morgan tests in `test/index.test.js` still pass.

Mocks: inject `s3Client` (or mock `@aws-sdk/client-s3`), mock/stub filesystem as needed; advance wall clock / inject a clock function for window boundaries (no timer mocks required).

## Out of scope for v1

- Response capture
- Header/body redaction
- Cross-instance single-file merge
- Compression of uploads
- Configurable filter (paths/methods skip lists)
- Integration with the Morgan factory config object

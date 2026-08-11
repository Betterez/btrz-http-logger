# S3 Request Recorder Middleware — Design

**Date:** 2026-08-10  
**Repo:** `btrz-http-logger`  
**Status:** Draft written — awaiting user review before implementation plan

## Goal

Add a **separate** Express middleware that records every HTTP request (all verbs) with the complete request payload and uploads windowed NDJSON files to an S3 bucket.

Constraints:

1. The middleware must **never fail** the HTTP request (no thrown errors, never call `next(err)`).
2. S3 upload must be **asynchronous and non-blocking** — the request path must call `next()` without waiting for upload completion.
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
  tempDir: undefined,               // optional; default os.tmpdir()
  s3Client: undefined               // optional; for tests / DI
}));
```

### Config rules

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `bucket` | yes | — | If missing/empty, return no-op middleware that only calls `next()`, with a one-time warning |
| `prefix` | no | `""` | Leading/trailing slashes normalized when building keys |
| `region` | no | SDK default | Passed to `@aws-sdk/client-s3` when creating client |
| `windowMinutes` | no | `15` | Both S3 key partition size and flush interval |
| `instanceId` | no | `hostname-pid` | Used in S3 object key |
| `tempDir` | no | `os.tmpdir()` | Local NDJSON buffer directory |
| `s3Client` | no | new `S3Client` | Injectable for unit tests |

Credentials use the default AWS SDK credential chain unless the injected `s3Client` is preconfigured.

## Request path behavior

For every request (all HTTP methods):

1. Build a record object (see below).
2. Best-effort append one NDJSON line to the current window’s local temp file.
3. Call `next()` immediately.
4. Never await S3 upload on this path.

Any error during serialize/append is caught and discarded (optional stderr log); `next()` still runs.

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
- Append is best-effort (`fs.appendFile` / sync equivalent wrapped in try/catch).

### Window = partition + flush

- `windowMinutes` (default 15) defines both:
  - the S3 key time partition, and
  - when to flush/upload and roll to a new temp file.
- Window start is computed in UTC by flooring the current time to `windowMinutes` (e.g. with 15: `03:00`, `03:15`, `03:30`, `03:45`).
- Flush trigger: on each request, if the computed window start differs from the active window, fire-and-forget upload the previous temp file via `PutObject`, then append the new record to a new temp file for the current window. A backup `setInterval` aligned to `windowMinutes` also flushes idle windows with pending data (so quiet periods still upload).
- Optional best-effort flush on `SIGTERM` / `SIGINT` (still non-throwing; not awaited by request handlers).
- After a successful upload, the local temp file for that window may be deleted (best-effort).

### S3 object key

```text
{prefix}/{yyyy}/{MM}/{dd}/{HHmm}-{instanceId}.ndjson
```

Example: `http-requests/sales/2026/08/11/0315-i-abc123.ndjson`

- Times in UTC.
- `{HHmm}` is the window start (floored to `windowMinutes`).
- One object per **instance** per window (no shared key across processes).
- Upload sends the full temp file contents for that window (`PutObject` overwrite of that instance key).

### Async / never-fail upload

- Upload started with a Promise that is not awaited on the request path.
- Rejected uploads are caught and logged; never rethrown to Express.
- Request latency must not include S3 round-trip time.

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
| Missing `bucket` | No-op middleware; `next()` only |
| Temp dir / append failure | Log; `next()` |
| Body / JSON serialize failure | Record without `body`; `next()` |
| S3 `PutObject` failure | Log asynchronously; request already continued |
| Unexpected throw in middleware | Catch; `next()` |

## Testing strategy (TDD-first)

Implementation order is strictly:

1. Add failing unit tests in `test/s3-request-recorder.test.js`.
2. Implement the minimum code to pass.
3. Refactor while keeping tests green.

### Required test cases

1. Calls `next()` even when append fails.
2. Calls `next()` without waiting for S3 upload to resolve.
3. Writes NDJSON including method, url, headers, query.
4. Includes `body` only when `req.body` is present.
5. Builds S3 key from window start + `instanceId` (UTC).
6. Flushes/uploads on window boundary.
7. Returns no-op when `bucket` is missing.
8. Existing Morgan tests in `test/index.test.js` still pass.

Mocks: inject `s3Client` (or mock `@aws-sdk/client-s3`), mock/stub filesystem as needed, fake timers for window boundaries.

## Out of scope for v1

- Response capture
- Header/body redaction
- Cross-instance single-file merge
- Compression of uploads
- Configurable filter (paths/methods skip lists)
- Integration with the Morgan factory config object

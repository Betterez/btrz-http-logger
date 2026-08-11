# README + explicit S3 credentials — Design

**Date:** 2026-08-11  
**Repo:** `btrz-http-logger`  
**Status:** Approved for planning

## Goal

1. Add a root `README.md` that documents how API teams install and configure both the existing Morgan factory and `s3RequestRecorder`.
2. Change `s3RequestRecorder` so AWS auth comes **only** from the config object (no default SDK credential chain, no env lookup inside the middleware).

## Non-goals

- Wiring `s3RequestRecorder` into any specific API repo in this change
- IAM policy deep-dive
- Suggested `process.env` keys or field remapping in API `index.js`
- Documenting `btrz-req-replay` beyond optional one-line mention (out of scope unless needed later)
- Changing Morgan behavior

## README structure (install-first cookbook)

Root `README.md`:

1. **Overview** — Morgan access logs + optional `s3RequestRecorder` NDJSON capture to S3
2. **Install** — depend on current package version; note `@aws-sdk/client-s3` is a package dependency
3. **Morgan (brief)** — `httpLogger(app, stream, name, config)` with `config.request` / `config.response` / optional `config.colorize`; example matching existing APIs
4. **s3RequestRecorder** — config file shape, one-liner mount, config table, mount notes, record shape, S3 key pattern
5. **Behavior notes** — never-fail request path; no-op when required config/`logger` missing

### Morgan example

```js
const httpLogger = require("btrz-http-logger");
httpLogger(app, getHttpLogger(), "btrz-api-sales", config.logging);
```

### s3RequestRecorder install in an API

Config file (or config module) already uses the middleware’s object shape — **no remapping**:

```js
// config (excerpt)
s3RequestRecorder: {
  bucket: "my-bucket",
  prefix: "http-requests/btrz-api-sales",
  region: "us-east-1",
  credentials: {
    accessKeyId: "...",
    secretAccessKey: "..."
    // sessionToken optional
  },
  windowMinutes: 15 // optional
}
```

```js
const httpLogger = require("btrz-http-logger");
const {s3RequestRecorder} = httpLogger;

httpLogger(app, getHttpLogger(), "btrz-api-sales", config.logging);
// Mount after body-parser so `req.body` is available when present
app.use(s3RequestRecorder(config.s3RequestRecorder, logger));
```

### Config table (document in README)

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `bucket` | yes | — | Missing/empty → no-op |
| `region` | yes | — | Required; no region default chain |
| `credentials.accessKeyId` | yes | — | Missing → no-op |
| `credentials.secretAccessKey` | yes | — | Missing → no-op |
| `credentials.sessionToken` | no | — | Temporary credentials |
| `prefix` | no | `""` | Normalized when building keys |
| `windowMinutes` | no | `15` | UTC window / flush partition |
| `instanceId` | no | `hostname-pid` | Used in S3 object key |
| `tempDir` | no | `os.tmpdir()` | Local NDJSON buffer directory |
| `logger` (2nd arg) | yes | — | `btrz-logger` instance; missing → no-op |

### Record shape / S3 key (short sections in README)

NDJSON line fields: `ts`, `method`, `url`, `path`, `query`, `headers`, optional `body`, `status`, `durationMs`, optional `aborted`.

Key pattern: `{prefix}/{yyyy}/{MM}/{dd}/{HHmm}-{instanceId}.ndjson` (UTC).

### Behavior notes

- Middleware never fails the HTTP request and never calls `next(err)`.
- Missing required config or `logger` → no-op that only calls `next()`.
- Status/duration captured on response `finish`/`close`.
- Mount after body-parser for body capture; status works regardless of mount position.
- Uploads are async and windowed; shutdown flushes best-effort.

## Code change: explicit credentials only

Today:

```js
const s3Client = new S3Client(config.region ? {region: config.region} : {});
```

This uses the AWS SDK default credential provider chain. That must stop.

### Required behavior

1. Build `S3Client` only when `bucket`, `region`, and `credentials.accessKeyId` + `credentials.secretAccessKey` are present (and `logger` is passed).
2. Pass credentials explicitly:

```js
new S3Client({
  region: config.region,
  credentials: {
    accessKeyId: config.credentials.accessKeyId,
    secretAccessKey: config.credentials.secretAccessKey,
    ...(config.credentials.sessionToken
      ? {sessionToken: config.credentials.sessionToken}
      : {})
  }
});
```

3. If any required auth/config field is missing → same no-op middleware path as missing `bucket` (one-time `logger.error` when logger is present).
4. Do **not** read AWS credentials from environment inside this package.
5. Do **not** construct an `S3Client` without explicit `credentials`.

### Tests

Extend `test/s3-request-recorder.test.js`:

- No-op when `credentials` missing (even if `bucket` set)
- No-op when `region` missing
- Active middleware constructs client with provided credentials (assert via injectable test seam or by observing successful Put with mocked client as today — prefer extending existing mock patterns; if client construction is hard to assert, add a minimal test-only seam only if needed)
- Existing happy-path tests updated to pass `region` + `credentials` in config

## Implementation order

1. TDD: update/add tests for credentials/`region` requirements and no default chain.
2. Implement `S3Client` construction + no-op rules in `src/s3-request-recorder.js`.
3. Write root `README.md` per this design.
4. Run `npm test` and ESLint; keep green.

## Out of scope

- Changing how API repos load secrets into `config.s3RequestRecorder` (that remains each API’s config system)
- Cross-repo README updates

# btrz-http-logger

Express HTTP logging for Betterez APIs:

- **Morgan factory** (default export) — request/response access logs
- **`s3RequestRecorder`** — windowed NDJSON request capture uploaded to S3 (for replay / analysis)

## Install

```bash
npm install btrz-http-logger@^2.5.0
```

`@aws-sdk/client-s3` is included as a dependency of this package.

## Morgan (access logs)

```js
const httpLogger = require("btrz-http-logger");

httpLogger(app, getHttpLogger(), "btrz-api-sales", config.logging);
```

| `config.logging` | Meaning |
|------------------|---------|
| `request` | Log each request when it starts (`immediate`) |
| `response` | Log each response when it finishes |
| `colorize` | Optional ANSI colors for local/dev streams |

`stream` is whatever your API already uses (e.g. a `btrz-logger` / rotating file stream from `getHttpLogger()`).

`responselength` in the response log is the `Content-Length` header when the response has one. Streamed (chunked)
responses have no `Content-Length`, so when `response` logging is enabled the logger also counts the body bytes passed to
`res.write()` / `res.end()` and logs that count instead. For a response that is aborted mid-stream, this is the number
of bytes written before the abort. It is `-` when no headers were sent.

Call `httpLogger(...)` before registering routes so the byte counting middleware wraps every response.

## s3RequestRecorder

Records each HTTP request (method, URL, headers, query, optional body, response `status`, `durationMs`) as NDJSON and uploads per time window to S3.

The middleware **never** fails the request path and never calls `next(err)`. AWS credentials must be supplied in config — the recorder does **not** use the SDK default credential chain or read credentials from the environment.

### Config shape

Put an object with this shape in your API config (e.g. `config.s3RequestRecorder`). Pass that object straight through — no remapping:

```js
s3RequestRecorder: {
  bucket: "my-bucket",
  prefix: "http-requests/btrz-api-sales",
  region: "us-east-1",
  credentials: {
    accessKeyId: "...",
    secretAccessKey: "..."
    // sessionToken: "..." // optional, for temporary credentials
  },
  windowMinutes: 15 // optional, default 15
}
```

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `bucket` | yes | — | Missing/empty → no-op middleware |
| `region` | yes | — | Passed to `S3Client` |
| `credentials.accessKeyId` | yes | — | Missing → no-op |
| `credentials.secretAccessKey` | yes | — | Missing → no-op |
| `credentials.sessionToken` | no | — | Temporary credentials |
| `prefix` | no | `""` | Leading/trailing slashes normalized |
| `windowMinutes` | no | `15` | UTC window size for keys / flush |
| `instanceId` | no | `hostname-pid` | Used in the S3 object key |
| `tempDir` | no | `os.tmpdir()` | Local NDJSON buffer directory |

Second argument: a `btrz-logger` `Logger` instance (`info` / `error` / …). Missing logger → no-op.

### Mount in an API

```js
const httpLogger = require("btrz-http-logger");
const {s3RequestRecorder} = httpLogger;

httpLogger(app, getHttpLogger(), "btrz-api-sales", config.logging);

// After body-parser (so `req.body` is available when present)
app.use(s3RequestRecorder(config.s3RequestRecorder, logger));
```

If `config.s3RequestRecorder` is missing required fields, the middleware is a no-op (safe to leave unset in local/dev).

### Record shape

Each line is one JSON object, for example:

```json
{
  "ts": "2026-08-11T03:15:22.123Z",
  "method": "POST",
  "url": "/v1/orders?foo=1",
  "path": "/v1/orders",
  "query": { "foo": "1" },
  "headers": { "host": "api.example.com" },
  "body": { "a": 1 },
  "status": 201,
  "durationMs": 42
}
```

- `body` is included only when `req.body` is defined.
- `aborted: true` is set only when the response closes without `finish`.
- Headers are recorded as received, except for credit card data (see below).

### Credit card masking

Before a record is written to disk or S3, credit card data in `url`, `path`, `query`, `headers` and `body` is
replaced with `x` (one `x` per character):

- **By field name** (object keys, form-encoded / query-string keys, header names; case and `-`/`_` insensitive):
  - card numbers: `cardNumber`, `ccNumber`, `creditCardNumber`, `cardNo`, `pan`, …
  - security codes: `cvv`, `cvv2`, `cvc`, `ccv`, `cvn`, `securityCode`, `cardCode`, …
  - AVS: `avs`, `avsCode`, `avsResult`, `avsZip`, …
  - expiration: `expMonth`, `expYear`, `expirationMonth`, `expiryYear`, `ccExp`, `cardExpiration`, …
  - inside a card object, generic keys are masked too: `number`, `exp*`, `expiration*`, `month`, `year`, `code`,
    `authorization`. A card object is any value under a key containing `card`, `credit` or starting with `cc`
    (e.g. `creditCard: {...}`, `customerCard: {...}`), or any object / query string that holds a card number field
    or a card number value (e.g. a `btrz-api-sales` order payment
    `{method: "online_credit", ccnumber, authorization, expiryMonth, expiryYear}`).

  If a matched field holds an object or array, every string/number leaf in it is masked.
- **By value** anywhere in the record: 13–19 digit runs (optionally separated by spaces or dashes) that start with a
  card network prefix and pass the Luhn check. Only the digits are replaced, separators are kept.

### S3 object key

```text
{prefix}/{yyyy}/{MM}/{dd}/{HHmm}-{instanceId}.ndjson
```

Example: `http-requests/btrz-api-sales/2026/08/11/0315-i-abc123.ndjson`

Times are UTC. `{HHmm}` is the window start (floored to `windowMinutes`). One object per process instance per window.

### Behavior notes

- Local append and S3 upload are asynchronous; `next()` is not delayed by I/O.
- A window file is uploaded when a later request observes a new window, or on `SIGTERM` / `SIGINT` (best-effort).
- If traffic stops inside a window, that file uploads on the next request after the window rolls, or on shutdown.

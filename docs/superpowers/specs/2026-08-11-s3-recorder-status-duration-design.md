# S3 Request Recorder — Response status + duration

**Date:** 2026-08-11  
**Repo:** `btrz-http-logger`  
**Status:** Implemented  
**Extends:** `docs/superpowers/specs/2026-08-10-s3-request-recorder-design.md`

## Goal

Extend `s3RequestRecorder` so each NDJSON record includes the HTTP **response status** and **duration**, without blocking or failing the request path, and without requiring consumers to remount the middleware later in the chain.

## Non-goals

- Response body capture
- Response header capture
- Changing the public config API / logger second-argument signature
- Moving mount order requirements (still: after body-parser for `req.body`; early mount is fine for status)

## Approach

**Defer append until the response ends; keep `ts` and S3 window at request start.**

1. On middleware entry (unchanged window-roll check using request-start time):
   - Snapshot `tempPath` for this request’s window.
   - Snapshot request fields into a record (`ts`, method, url, path, query, headers, optional body) — same rules as today.
   - Record `startMs = Date.now()` (or `start = new Date()` used for both `ts` and duration).
   - Register one-shot listeners on `res` for `finish` and `close`.
   - Call `next()` immediately (no append yet).
2. On `finish` (preferred) or `close` without a prior `finish`:
   - Set `status` from `res.statusCode`.
   - Set `durationMs` = `Date.now() - startMs` (integer ≥ 0).
   - If this is `close` and `finish` never fired → set `aborted: true`; on normal `finish`, omit `aborted`.
   - Serialize and `trackAppend(snapshottedTempPath, line)` (fire-and-forget).
   - Ensure listeners run at most once (guard flag).

Mounting later in the chain is **not** required: `finish`/`close` observe the final status regardless of middleware position.

## Record shape (delta)

Existing fields unchanged. Add:

| Field | When | Notes |
|-------|------|-------|
| `status` | always on written records | `res.statusCode` number |
| `durationMs` | always on written records | milliseconds from request-start to finish/close |
| `aborted` | only if recorded via `close` without `finish` | boolean `true`; omit otherwise |

Example completed record:

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

Aborted example (extra field only):

```json
{
  "ts": "2026-08-11T03:15:22.123Z",
  "method": "GET",
  "url": "/v1/slow",
  "path": "/v1/slow",
  "query": {},
  "headers": {},
  "status": 200,
  "durationMs": 1200,
  "aborted": true
}
```

Requests that never emit `finish` or `close` are not written (same as “no line” today if the process dies mid-request; SIGTERM flush still uploads whatever was already appended).

## Window / flush interaction (required for correctness)

Because append is deferred, a request that **starts** in window W1 may still be open when a later request rolls to W2 and would previously flush/delete W1’s temp file.

**Rule:** associate each in-flight recording with its snapshotted `tempPath`. Do **not** upload+delete that path while any in-flight recordings still target it.

Minimal mechanism (implementation detail OK as long as tests lock behavior):

- Per `tempPath`, track `pendingFinalizers` (or equivalent) incremented when a request snapshots that path, decremented when its finish/close append is scheduled (or fails to schedule).
- When the active window rolls, if the previous path still has `pendingFinalizers > 0`, mark it `flushWhenIdle` and skip immediate upload; when the last pending finalizer completes (after scheduling its append into `trackAppend`), trigger the same flush/upload/delete path used today (still waiting for in-flight appends via existing `trackAppend` tracking).
- If the path has zero pending finalizers at roll time, flush immediately as today.

Window identity and S3 key remain based on **request start** time (least change from current partitioning).

## Constraints (unchanged)

- Never throw / never `next(err)`.
- Never await append or S3 before `next()`.
- No `setInterval`.
- Logger via second argument; S3 client internal; real `fs.promises` / `Date`.

## Testing (TDD additions)

1. `next()` is called before any append for that request.
2. After simulated `res.emit("finish")`, NDJSON includes `status` and `durationMs`; no `aborted`.
3. After `res.emit("close")` without `finish`, record includes `aborted: true`, `status`, `durationMs`.
4. Only one line when both `finish` and `close` fire.
5. Request that starts in window W1 and finishes after a later request rolled to W2 still appends to W1’s file; W1 is not deleted until that pending request finalizes (then flush runs).
6. Existing behaviors remain: body omit rules, never-fail `next()`, upload+delete on flush, signal flush, Morgan tests.

## Out of scope

- Response body / response headers
- Changing field names to match Morgan tokens
- Backfilling status onto already-uploaded objects

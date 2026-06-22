# `supabase seed buckets`

Seeds the **local** Supabase Storage stack from `[storage.buckets]` and
`[storage.vector]` in `supabase/config.toml`. Port of
`apps/cli-go/internal/seed/buckets/buckets.go`.

## Files Read

| Path                                 | Format      | When                                                               |
| ------------------------------------ | ----------- | ------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`     | TOML        | always, to read `[storage.buckets]` / `[storage.vector]` config    |
| `<workdir>/<bucket>.objects_path/**` | any (bytes) | per configured bucket with a non-empty `objects_path`, recursively |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

All routes target the local **Storage service gateway** (Kong) at
`api.external_url` (default `http://<host>:54321`, where `<host>` follows Go's
`utils.GetHostname`: `SUPABASE_SERVICES_HOSTNAME` → TCP `DOCKER_HOST` → `127.0.0.1`).
Auth: an `apikey` header set to the local service-role key
(`auth.service_role_key`, or a JWT signed from `auth.jwt_secret`); an
`Authorization: Bearer <key>` header is also sent, except when the key is an
opaque `sb_...` key, which Go's `withAuthToken` (`pkg/fetcher/gateway.go:22`)
treats as a non-JWT and omits.

| Method | Path                                    | Auth         | Request body                                                                            | Response (used fields)                 |
| ------ | --------------------------------------- | ------------ | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `GET`  | `/storage/v1/bucket`                    | service-role | none                                                                                    | `[{name, id}]`                         |
| `POST` | `/storage/v1/bucket`                    | service-role | `{name, public, file_size_limit?, allowed_mime_types?}`                                 | — (created)                            |
| `PUT`  | `/storage/v1/bucket/{id}`               | service-role | `{public, file_size_limit?, allowed_mime_types?}`                                       | — (updated)                            |
| `POST` | `/storage/v1/vector/ListVectorBuckets`  | service-role | `{}`                                                                                    | `{vectorBuckets:[{vectorBucketName}]}` |
| `POST` | `/storage/v1/vector/CreateVectorBucket` | service-role | `{vectorBucketName}`                                                                    | — (created)                            |
| `POST` | `/storage/v1/vector/DeleteVectorBucket` | service-role | `{vectorBucketName}`                                                                    | — (pruned)                             |
| `POST` | `/storage/v1/object/{bucket}/{key}`     | service-role | raw file bytes; headers `Content-Type`, `Cache-Control: max-age=3600`, `x-upsert: true` | — (uploaded)                           |

`file_size_limit` is omitted from the body when `0`; `allowed_mime_types` is
omitted when empty (Go `omitempty`).

## Environment Variables

| Variable                     | Purpose                                                                                  | Required? |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_SERVICES_HOSTNAME` | override the local services host (highest precedence)                                    | no        |
| `DOCKER_HOST`                | when a `tcp://host:port` endpoint, the local services host falls back to it before `127.0.0.1` | no        |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success (including the empty-config short-circuit)              |
| `1`  | `supabase/config.toml` parse failure                            |
| `1`  | `auth.jwt_secret` set but shorter than 16 characters            |
| `1`  | Storage API error (non-2xx) other than vector-unavailable       |
| `1`  | network / connection failure to the Storage gateway             |
| `1`  | unreadable `objects_path` (filesystem error during walk/upload) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom `phtelemetry.*` events exist in the Go command.

## Output

### `--output-format text` (Go CLI compatible)

All progress is written to **stderr** (stdout stays empty), byte-matching Go:

```
Creating Storage bucket: <name>
Updating Storage bucket: <id>
Updating vector buckets...
Bucket already exists: <name>
Creating vector bucket: <name>
Pruning vector bucket: <name>
Uploading: <objects_path>/<rel> => <bucket>/<rel>
Skipping non-regular file: <path>
WARNING: Vector buckets are not available in this project's region yet. Skipping vector bucket seeding.
WARNING: Vector buckets are not available in the local storage service. If this project is linked, run `supabase link` to update service versions, then restart the local stack. Skipping vector bucket seeding.
```

Interactive (TTY) prompts:

```
Bucket <id> already exists. Do you want to overwrite its properties? [Y/n]
Bucket <name> not found in supabase/config.toml. Do you want to prune it? [y/N]
```

### `--output-format json`

Additive (no Go equivalent). A final `result` object summarising the run is
emitted on stdout; progress/prompts are suppressed (prompts use their defaults:
overwrite → yes, prune → no).

### `--output-format stream-json`

Additive. NDJSON events; the operation's progress lines are suppressed from
stdout and a terminal `result`/`error` event is emitted.

## Notes

- **Local-only.** Go's `seed` command defines no `--project-ref` flag, so
  `flags.ParseProjectRef` never runs and the project ref is always empty. The
  remote client factory, service-role-key resolution via the Management API, and
  analytics-bucket upsert (gated on a non-empty ref) are therefore unreachable
  and are not implemented. `--linked` and `--local` are accepted for CLI-surface
  parity but both seed the local stack identically.
- **Vector graceful skip.** When vector buckets are configured but the local
  service does not support them (`FeatureNotEnabled`, `Vector service not
configured`, or a 404 on `ListVectorBuckets`), a WARNING is printed and object
  upload still proceeds; the command exits `0`.
- **Idempotent.** Existing buckets are updated (after an overwrite confirm),
  objects are uploaded with `x-upsert: true`.
- **Content-Type** for uploaded objects is derived from the file extension — a
  best-effort approximation of Go's `http.DetectContentType` + `mime.TypeByExtension`.

# `supabase seed buckets`

Seeds Supabase Storage buckets from `[storage.buckets]` and
`[storage.vector]` in `supabase/config.toml`. Port of
`apps/cli-go/internal/seed/buckets/buckets.go`. Without `--linked` the local
stack is used; with `--linked` the remote project is used.

## Files Read

| Path                                     | Format      | When                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`         | TOML        | always, to read `[storage.buckets]` / `[storage.vector]` config; on `--linked`, the matching `[remotes.<name>]` block (whose `project_id` equals the resolved project ref) is merged over the base config before decode, so remote-specific storage config takes effect          |
| `<workdir>/supabase/<objects_path>/**`   | any (bytes) | per configured bucket with a non-empty `objects_path`, recursively; a relative `objects_path` resolves under `supabase/` (Go `config.go:757-759`), an absolute path is used as-is                                                                                                |
| `<workdir>/supabase/<api.tls.cert_path>` | PEM text    | local runs only, when `[api.tls] enabled = true` AND `api.tls.cert_path` is set; the file is read to obtain the CA certificate for trusting the local Kong HTTPS gateway. If `cert_path` is not set, the embedded `kong.local.crt` constant is used instead (no file read).      |
| `<workdir>/supabase/<api.tls.key_path>`  | PEM text    | local runs only, when `[api.tls] enabled = true` AND `api.tls.key_path` is set; read purely to validate the cert/key pairing (Go `config.go:845-861`) — the key content is not used by the CLI. If `cert_path` is set without `key_path` (or vice-versa), the command exits `1`. |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | `--linked` only, once the project ref resolves and no cache exists yet — mirrors Go's `ensureProjectGroupsCached` (`cmd/root.go`). Best-effort (auth/network/write errors are swallowed). Local runs never write it. |

## API Routes

### Storage gateway routes (local and remote)

**Local:** `api.external_url` (default `http://<host>:54321`, where `<host>` follows Go's
`utils.GetHostname`: `SUPABASE_SERVICES_HOSTNAME` → TCP `DOCKER_HOST` → `127.0.0.1`).

**Remote (`--linked`):** `https://<ref>.<projectHost>` (default host: `supabase.co`).

Auth: an `apikey` header set to the service-role key; an `Authorization: Bearer <key>`
header is also sent, except when the key is an opaque `sb_...` key, which Go's
`withAuthToken` (`pkg/fetcher/gateway.go:22`) treats as a non-JWT and omits.

| Method   | Path                                    | Auth         | Request body                                                                            | Response (used fields)                 |
| -------- | --------------------------------------- | ------------ | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `GET`    | `/storage/v1/bucket`                    | service-role | none                                                                                    | `[{name, id}]`                         |
| `POST`   | `/storage/v1/bucket`                    | service-role | `{name, public, file_size_limit?, allowed_mime_types?}`                                 | — (created)                            |
| `PUT`    | `/storage/v1/bucket/{id}`               | service-role | `{public, file_size_limit?, allowed_mime_types?}`                                       | — (updated)                            |
| `POST`   | `/storage/v1/vector/ListVectorBuckets`  | service-role | `{}`                                                                                    | `{vectorBuckets:[{vectorBucketName}]}` |
| `POST`   | `/storage/v1/vector/CreateVectorBucket` | service-role | `{vectorBucketName}`                                                                    | — (created)                            |
| `POST`   | `/storage/v1/vector/DeleteVectorBucket` | service-role | `{vectorBucketName}`                                                                    | — (pruned)                             |
| `POST`   | `/storage/v1/object/{bucket}/{key}`     | service-role | raw file bytes; headers `Content-Type`, `Cache-Control: max-age=3600`, `x-upsert: true` | — (uploaded)                           |
| `GET`    | `/storage/v1/iceberg/bucket`            | service-role | none                                                                                    | `[{name, id, created_at, updated_at}]` |
| `POST`   | `/storage/v1/iceberg/bucket`            | service-role | `{bucketName}`                                                                          | — (created)                            |
| `DELETE` | `/storage/v1/iceberg/bucket/{name}`     | service-role | none                                                                                    | — (pruned)                             |

A bucket that omits `file_size_limit` (or sets it to `0`) inherits the
storage-level `[storage].file_size_limit` (Go `config.go:753-756`). The
storage-level limit and all bucket sizes are parsed up front (the storage-level
one unconditionally, even with only vector buckets), so an invalid value fails
before any Storage call.
`file_size_limit` is omitted from the body when the resolved value is `0`;
`allowed_mime_types` is omitted when empty (Go `omitempty`).

Analytics bucket routes (`/storage/v1/iceberg/...`) are only reached when
`[storage.analytics].enabled = true` AND `--linked` is passed.

### Management API routes (remote `--linked` only, when env var not set)

| Method | Path                                      | When                                        | Response (used fields)                         |
| ------ | ----------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | `SUPABASE_AUTH_SERVICE_ROLE_KEY` is not set | `[{name, api_key, type, secret_jwt_template}]` |

## Environment Variables

| Variable                         | Purpose                                                                                                                                                                                                               | Required? |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_SERVICES_HOSTNAME`     | override the local services host (highest precedence)                                                                                                                                                                 | no        |
| `DOCKER_HOST`                    | when a `tcp://host:port` endpoint, the local services host falls back to it before `127.0.0.1`                                                                                                                        | no        |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY` | when set and non-empty: for `--linked`, used as the service-role key (skips Management API key fetch); for local runs, used as the service-role key instead of `auth.service_role_key` (Go Viper AutomaticEnv parity) | no        |
| `SUPABASE_AUTH_JWT_SECRET`       | local runs only: when set and non-empty, overrides `auth.jwt_secret` for service-role key derivation (Go Viper `AutomaticEnv`+`SUPABASE_` prefix parity, `config.go:492-497`)                                         | no        |

## Exit Codes

| Code | Condition                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| `0`  | success (including the empty-config short-circuit)                                                            |
| `1`  | `supabase/config.toml` parse failure                                                                          |
| `1`  | `auth.jwt_secret` (or `SUPABASE_AUTH_JWT_SECRET`) set but shorter than 16 characters                          |
| `1`  | `[storage.buckets]` entry has an invalid name (contains characters outside Go's `ValidateBucketName` regex)   |
| `1`  | `api.tls.cert_path` set without `api.tls.key_path` (or vice-versa) when `api.tls.enabled = true` (local only) |
| `1`  | `api.tls.cert_path` or `api.tls.key_path` points to an unreadable file (local TLS only)                       |
| `1`  | Storage API error (non-2xx) other than vector-unavailable                                                     |
| `1`  | network / connection failure to the Storage gateway                                                           |
| `1`  | malformed list response (a 200 body whose shape doesn't decode, mirroring Go's strict `ParseJSON`)            |
| `1`  | unreadable `objects_path` (filesystem error during walk/upload)                                               |

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
Updating analytics buckets...
Bucket already exists: <name>
Creating analytics bucket: <name>
Pruning analytics bucket: <name>
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

- **Remote (`--linked`) — config override merge.** The project ref is resolved
  BEFORE config is loaded. `loadProjectConfig` then merges the `[remotes.<name>]`
  block whose `project_id` equals the resolved ref over the base config (including
  `storage.buckets`, `storage.vector`, `storage.analytics`), mirroring Go's
  `Config.ProjectId = ProjectRef` → `config.Load` sequence (`config.go:505-518`).
  Local runs load the base config verbatim with no merge.
- **Remote (`--linked`).** The remote base URL is `https://<ref>.<projectHost>`
  (default: `supabase.co`). The service-role key is read from
  `SUPABASE_AUTH_SERVICE_ROLE_KEY` if set; otherwise fetched via
  `GET /v1/projects/{ref}/api-keys?reveal=true`.
- **Bucket name validation.** Every `[storage.buckets]` name is validated against
  Go's `ValidateBucketName` regex (`^(\w|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$`,
  `config.go:1382`) before any Storage call. Invalid names exit `1` with the exact
  Go error message. Vector and analytics bucket names are NOT validated.
- **Local env-var overrides.** For local runs, `SUPABASE_AUTH_JWT_SECRET` (if set
  and non-empty) overrides `auth.jwt_secret`, and `SUPABASE_AUTH_SERVICE_ROLE_KEY`
  (if set and non-empty) overrides `auth.service_role_key`, mirroring Go's Viper
  `AutomaticEnv`+`SUPABASE_` prefix (`config.go:492-497`). The `<16`-char rejection
  applies to the resolved secret (env or config value).
- **Analytics buckets.** Analytics bucket upsert (`/storage/v1/iceberg/...`) is
  gated on `[storage.analytics].enabled = true` AND `--linked`. It is never
  reached for local runs. Errors from analytics routes propagate (no graceful skip).
- **Vector graceful skip.** When vector buckets are configured but the local
  service does not support them (`FeatureNotEnabled`, `Vector service not
configured`, or a 404 on `ListVectorBuckets`), a WARNING is printed and object
  upload still proceeds; the command exits `0`.
- **Idempotent.** Existing buckets are updated (after an overwrite confirm),
  objects are uploaded with `x-upsert: true`.
- **Content-Type** for uploaded objects mirrors Go (`objects.go:77-108`): the first
  512 bytes are sniffed with a 1:1 port of `http.DetectContentType`
  (`legacy/shared/legacy-detect-content-type.ts`), and only a generic `text/plain`
  result is refined by extension via Go's built-in `mime` table. (Go's
  `mime.TypeByExtension` also consults the host OS MIME database, which is
  host-dependent and not reproduced; the deterministic built-in table is used.)
- **Local Kong TLS.** When `[api.tls] enabled = true` for a local stack, the
  cert/key pairing is validated before seeding (Go `(*api).Validate`, `config.go:845-861`):
  `cert_path` and `key_path` must both be set or both absent; setting only one exits `1`.
  When both are set, both files are read for validation; `cert_path` provides the CA PEM
  used to trust the Kong gateway. If neither is set, the embedded `kong.local.crt` constant
  is used. Resolved against `<workdir>/supabase/` (or absolute path as-is). The CA is
  injected into Bun's `fetch` via `tls: { ca: <pem> }` — no system trust store modification.

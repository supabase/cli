# `supabase gen types`

## Files Read

| Path                                      | Format     | When                                                                                     |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--project-id`                      |
| `<workdir>/supabase/config.toml`          | TOML       | when selecting schemas; `--local` uses embedded defaults when the file is missing        |
| `<workdir>{/supabase}/.env*`              | dotenv     | `--local`; resolves the same nested environment overrides as the legacy CLI              |
| `<workdir>/supabase/.temp/rest-version`   | plain text | `--local` only, when `db.major_version > 14` — forces v9 compat if the tag contains `v9` |
| `<workdir>/supabase/.temp/pgmeta-version` | plain text | `--local` only — overrides the pg-meta docker image tag                                  |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

No files are written. Container env (including the DB URL and TLS CA bundle) is
passed via container CLI `run --env KEY=VALUE` arguments, mirroring Go's
`container.Config.Env`; no temporary env-file is created.

## API Routes

| Method | Path                                        | Auth         | Request body           | Response (used fields)                     |
| ------ | ------------------------------------------- | ------------ | ---------------------- | ------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/types/typescript`       | Bearer token | none                   | TypeScript type definitions text           |
| `GET`  | `/v1/projects/{ref}`                        | Bearer token | none                   | (presence only; `404` ⇒ branch ref)        |
| `GET`  | `/v1/branches/{branch_id_or_ref}`           | Bearer token | none                   | `db_host`, `db_port`, `db_user`, `db_pass` |
| `POST` | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }` | temporary `role` and `password`            |
| `GET`  | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                   | primary pooler `connection_string`         |

The TypeScript endpoint is called for `--linked`, `--project-id`, and the implicit
linked-project fallback when `--lang=typescript`. For other languages on those
project-ref paths — a sanctioned intentional divergence from the Go CLI, see Notes
(CLI-1988) — the project endpoint is probed first: a `404` means the ref is a
preview branch (any 404 body), so the branch endpoint supplies the branch database
host/port and credentials for pg-meta. Otherwise the database connection is resolved
for the ref and the login-role endpoint supplies temporary credentials for pg-meta.
On an IPv4-only network where the direct database host is unreachable, project-ref
pg-meta generation retries once through the IPv4 pooler only when the current target
host is the project's direct `db.<ref>` host and the pooler URL matches the expected
tenant and pooler domain. An explicit `--project-id` ref fetches the primary pooler
config for that ref to build the fallback connection (the saved workdir
`.temp/pooler-url` is ignored because the ref may differ from the linked workdir).
`--local` and `--db-url` do not call the Management API.

## Subprocesses

| Command                                                                                | When                                                                  | Purpose                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `docker`/`podman container inspect supabase_db_<project_id>`                           | `--local`                                                             | assert `supabase start` is running                 |
| `docker`/`podman run --rm --network <net> --env … <pgmeta> node dist/server/server.js` | `--local`, `--db-url`, project-ref paths with non-TypeScript `--lang` | run pg-meta to generate types from a live database |

A raw TCP `SSLRequest` probe is also opened to the target database host/port to
detect TLS support before launching pg-meta (mirrors Go's `isRequireSSL`) with the
default 10s pg-delta probe timeout.

## Environment Variables

| Variable                           | Purpose                                                                                     | Required?                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`            | auth token for linked/project-id mode                                                       | no (falls back to keyring → `~/.supabase/access-token`)                                                       |
| `SUPABASE_PROJECT_ID`              | local Docker container and network project ID                                               | no (falls back to the workdir name)                                                                           |
| `SUPABASE_DB_PORT`                 | local database probe port                                                                   | no (defaults to `54322`)                                                                                      |
| `SUPABASE_DB_MAJOR_VERSION`        | local PostgreSQL major version                                                              | no (defaults to `17`)                                                                                         |
| `SUPABASE_API_SCHEMAS`             | local schemas used when `--schema` is omitted                                               | no (defaults to `public,graphql_public`)                                                                      |
| `SUPABASE_ENV`                     | selects nested dotenv files for local generation                                            | no (defaults to `development`)                                                                                |
| `SUPABASE_PROFILE`                 | built-in profile name or YAML file path                                                     | no (falls back to `~/.supabase/profile` -> `supabase`)                                                        |
| `SUPABASE_DB_PASSWORD`             | database password for `--local` and the `--linked` workdir project                          | no (defaults to `postgres`; **ignored** for ad-hoc `--project-id`, which always mints a temporary login role) |
| `SUPABASE_SERVICES_HOSTNAME`       | host used for the local TLS probe                                                           | no (defaults to `127.0.0.1`)                                                                                  |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | pg-meta image registry override (`docker.io` → Docker Hub; any other value → that registry) | no (defaults to the ECR registry)                                                                             |
| `SUPABASE_CA_SKIP_VERIFY`          | when `true`, prints a TLS-verification-disabled warning to stderr                           | no                                                                                                            |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success — types printed to stdout                                |
| `1`  | no target specified (must use one flag)                          |
| `1`  | mutually exclusive flags combined (all four Go flag groups)      |
| `1`  | `--postgrest-v9-compat` used without `--db-url`                  |
| `1`  | invalid `--query-timeout` duration or invalid `--db-url`         |
| `1`  | `supabase start` not running (`--local`) or db inspection failed |
| `1`  | API error, TLS probe failure, or pg-meta container non-zero exit |

## Output

### `--output-format text` (Go CLI compatible)

Prints generated TypeScript (or other language) type definitions to stdout.
Diagnostics (`Connecting to …`, pg-meta logs) go to stderr.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Exactly one of `--local`, `--linked`, `--project-id`, or `--db-url` must be specified.
  All four of Go's mutually exclusive flag groups (`apps/cli-go/cmd/gen.go:153-162`) are
  enforced with cobra's exact error text and sorted group order:
  `local/linked/project-id/db-url`, plus `linked/project-id` against each of
  `postgrest-v9-compat`, `query-timeout`, and `swift-access-control`.
- With `--local`, a missing `supabase/config.toml` uses the embedded config defaults plus
  shell and nested dotenv overrides, matching the legacy CLI.
- **Sanctioned intentional divergence from the Go CLI (CLI-1988 parity ruling):**
  `--lang` accepts `typescript` (default), `go`, `swift`, or `python`. Project-ref paths
  (`--linked`, `--project-id`, and the implicit linked fallback) use the Management API
  for TypeScript, and run pg-meta locally against the project database (temporary
  login-role credentials, preview-branch fallback) for the other languages. The Go CLI
  instead hard-errors with `Unable to generate <lang> types for selected project. Try
using --db-url flag instead.` (`internal/gen/types/types.go:44-46`) and never runs
  pg-meta for a project ref. This permissiveness is deliberate — it resolves the
  user-filed CLI-1623 complaint — and was blessed in the CLI-1988 ruling. Do not
  "fix" it back to Go's error. Because Go's mutex groups are enforced unchanged, the
  pg-meta tuning flags (`--swift-access-control`, `--postgrest-v9-compat`,
  `--query-timeout`) cannot be combined with `--linked`/`--project-id`, so this
  project-ref pg-meta path always runs with pg-meta defaults (`internal` access
  control, one-to-one detection on, 15s timeout); use `--db-url` to tune them.
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- `--swift-access-control` accepts `internal` (default) or `public`. Matching Go, it is
  mutually exclusive with `--linked`/`--project-id`; on the `--local` and `--db-url`
  paths it is always forwarded to pg-meta regardless of `--lang`.
- `--postgrest-v9-compat` generates types compatible with PostgREST v9 and below.
  Matching Go's PreRun guard, it must be used together with `--db-url` (error:
  `--postgrest-v9-compat must used together with --db-url` — Go's typo included).
  `--local` still forces v9 compat when the local PostgREST image tag contains `v9`.
- `--query-timeout` sets the maximum timeout for pg-meta database queries (default 15s).
  Matching Go, it is mutually exclusive with `--linked`/`--project-id`; on the implicit
  linked TypeScript fallback it is accepted and silently unused.
- The legacy positional language argument (`supabase gen types typescript`) is still accepted;
  any other positional language requires an explicit `--lang` flag.
- The linked-project telemetry cache is written only when a project ref is resolved
  (`--linked`/`--project-id`/fallback), matching Go's `ensureProjectGroupsCached`, which
  returns early when no ref is available.

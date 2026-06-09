# `supabase gen types`

## Files Read

| Path                                      | Format     | When                                                                                     |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--project-id`                      |
| `<workdir>/supabase/config.toml`          | TOML       | when `--local` (required) or `--db-url` (best-effort) is specified                       |
| `<workdir>/supabase/.temp/rest-version`   | plain text | `--local` only, when `db.major_version > 14` — forces v9 compat if the tag contains `v9` |
| `<workdir>/supabase/.temp/pgmeta-version` | plain text | `--local` only — overrides the pg-meta docker image tag                                  |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

No files are written. Container env (including the DB URL and TLS CA bundle) is
passed via `docker run --env KEY=VALUE` arguments, mirroring Go's
`container.Config.Env`; no temporary env-file is created.

## API Routes

| Method | Path                                  | Auth         | Request body | Response (used fields)           |
| ------ | ------------------------------------- | ------------ | ------------ | -------------------------------- |
| `GET`  | `/v1/projects/{ref}/types/typescript` | Bearer token | none         | TypeScript type definitions text |

Called only for `--linked`, `--project-id`, and the implicit linked-project
fallback. `--local` and `--db-url` do not call the Management API.

## Subprocesses

| Command                                                                       | When                  | Purpose                                            |
| ----------------------------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| `docker container inspect supabase_db_<project_id>`                           | `--local`             | assert `supabase start` is running                 |
| `docker run --rm --network <net> --env … <pgmeta> node dist/server/server.js` | `--local`, `--db-url` | run pg-meta to generate types from a live database |

A raw TCP `SSLRequest` probe is also opened to the target database host/port to
detect TLS support before launching pg-meta (mirrors Go's `isRequireSSL`).

## Environment Variables

| Variable                           | Purpose                                                           | Required?                                               |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`            | auth token for linked/project-id mode                             | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`                 | override Management API base URL                                  | no (defaults to `https://api.supabase.com`)             |
| `SUPABASE_DB_PASSWORD`             | local database password for `--local`                             | no (defaults to `postgres`)                             |
| `SUPABASE_SERVICES_HOSTNAME`       | host used for the local TLS probe                                 | no (defaults to `127.0.0.1`)                            |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | pg-meta image registry override (`docker.io` → Docker Hub)        | no (defaults to the ECR registry)                       |
| `SUPABASE_CA_SKIP_VERIFY`          | when `true`, prints a TLS-verification-disabled warning to stderr | no                                                      |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success — types printed to stdout                                |
| `1`  | no target specified (must use one flag)                          |
| `1`  | mutually exclusive flags combined                                |
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
- `--lang` flag accepts `typescript` (default), `go`, `swift`, or `python`. Non-typescript
  languages require a direct database connection (`--local` or `--db-url`).
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- `--swift-access-control` accepts `internal` (default) or `public`.
- `--postgrest-v9-compat` generates types compatible with PostgREST v9 and below (requires `--db-url`).
- `--query-timeout` sets the maximum timeout for the database query (default 15s, direct connection only).
- The legacy positional language argument (`supabase gen types typescript`) is still accepted;
  any other positional language requires an explicit `--lang` flag.
- The linked-project telemetry cache is written only when a project ref is resolved
  (`--linked`/`--project-id`/fallback), matching Go's `ensureProjectGroupsCached`, which
  returns early when no ref is available.

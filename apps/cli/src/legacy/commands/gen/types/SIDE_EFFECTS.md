# `supabase gen types`

## Files Read

| Path                                      | Format     | When                                                                                     |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--project-id`                      |
| `<workdir>/supabase/config.toml`          | TOML       | when selecting schemas from config; required for `--local`, best-effort otherwise        |
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
project-ref paths, the project endpoint is probed first: a `404` means the ref is a
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
| `SUPABASE_PROFILE`                 | built-in profile name or YAML file path                                                     | no (falls back to `~/.supabase/profile` -> `supabase`)                                                        |
| `SUPABASE_DB_PASSWORD`             | database password for `--local` and the `--linked` workdir project                          | no (defaults to `postgres`; **ignored** for ad-hoc `--project-id`, which always mints a temporary login role) |
| `SUPABASE_SERVICES_HOSTNAME`       | host used for the local TLS probe                                                           | no (defaults to `127.0.0.1`)                                                                                  |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | pg-meta image registry override (`docker.io` → Docker Hub; any other value → that registry) | no (defaults to the ECR registry)                                                                             |
| `SUPABASE_CA_SKIP_VERIFY`          | when `true`, prints a TLS-verification-disabled warning to stderr                           | no                                                                                                            |

## Exit Codes

| Code | Condition                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — types printed to stdout                                                                                           |
| `1`  | no target specified (must use one flag)                                                                                     |
| `1`  | mutually exclusive flags combined                                                                                           |
| `1`  | pg-meta-only flags used with remote TypeScript generation, except implicit TypeScript `--query-timeout` warns and continues |
| `1`  | invalid `--query-timeout` duration or invalid `--db-url`                                                                    |
| `1`  | `supabase start` not running (`--local`) or db inspection failed                                                            |
| `1`  | API error, TLS probe failure, or pg-meta container non-zero exit                                                            |

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
- `--lang` flag accepts `typescript` (default), `go`, `swift`, or `python`. Project-ref
  paths use the Management API for TypeScript, and use a project database host +
  temporary login role + pg-meta for other languages.
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- `--swift-access-control` accepts `internal` (default) or `public`, and requires
  `--lang swift`.
- `--postgrest-v9-compat` generates types compatible with PostgREST v9 and below for pg-meta
  generation (`--local`, `--db-url`, or non-TypeScript project-ref paths).
- `--query-timeout` sets the maximum timeout for pg-meta database queries (default 15s).
  On remote TypeScript generation, explicit `--linked` or `--project-id` invocations
  error because pg-meta is not used; the implicit linked TypeScript fallback prints a
  warning and ignores the flag.
- The legacy positional language argument (`supabase gen types typescript`) is still accepted;
  any other positional language requires an explicit `--lang` flag.
- The linked-project telemetry cache is written only when a project ref is resolved
  (`--linked`/`--project-id`/fallback), matching Go's `ensureProjectGroupsCached`, which
  returns early when no ref is available.

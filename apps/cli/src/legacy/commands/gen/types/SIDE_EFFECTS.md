# `supabase gen types`

## Files Read

| Path                                    | Format     | When                                                                                                                                    |
| --------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`              | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--project-id`                                                                     |
| `<workdir>/supabase/config.toml`        | TOML       | when selecting schemas; `--local` uses embedded defaults when the file is missing                                                       |
| `<workdir>{/supabase}/.env*`            | dotenv     | `--local` (nested env overrides) and `--db-url` (shared resolver layers project env under shell `PG*` fallbacks before parsing the DSN) |
| `<workdir>/supabase/.temp/rest-version` | plain text | `--local` only, when `db.major_version > 14` — forces v9 compat if the tag contains `v9`                                                |
| `.pgpass` / `pg_service.conf`           | libpq      | `--db-url` only, when the DSN, `PGPASSFILE`/`PGSERVICEFILE`, or libpq defaults reference them                                           |
| `$PGSSLROOTCERT` CA bundle              | PEM        | `--db-url` only, when the DSN or `PGSSLROOTCERT` sets `sslrootcert`                                                                     |
| `$PGSSLCERT` / `$PGSSLKEY`              | PEM        | `--db-url` only, when the DSN or `PGSSLCERT`/`PGSSLKEY` set a client cert pair                                                          |

## Files Written

| Path                                       | Format | When                                                                                                                                                                               |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$TMPDIR/supabase-gen-types-ca-*/root.crt` | PEM    | remote native generation whose DSN has no explicit `sslmode` and the SSL probe reports TLS — scoped temp file of the embedded Supabase CA bundle, removed when generation finishes |

No project files are written. Container env is not used.

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
project-ref paths — a sanctioned intentional divergence, see Notes
(CLI-1988) — the project endpoint is probed first: a `404` means the ref is a
preview branch (any 404 body), so the branch endpoint supplies the branch database
host/port and credentials for native generation. Otherwise the database connection
is resolved for the ref and the login-role endpoint supplies temporary credentials.
On an IPv4-only network where the direct database host is unreachable, project-ref
generation retries once through the IPv4 pooler only when the current target
host is the project's direct `db.<ref>` host and the pooler URL matches the expected
tenant and pooler domain. An explicit `--project-id` ref fetches the primary pooler
config for that ref to build the fallback connection (the saved workdir
`.temp/pooler-url` is ignored because the ref may differ from the linked workdir).
`--local` and `--db-url` do not call the Management API.

## Database Access

Except for the project-ref TypeScript path (Management API), types are generated
in-process by `@supabase/postgrest-typegen`: the CLI opens a direct Postgres
connection to the target database (the shared driver layer handles TLS for
remote targets and the `--dns-resolver` DoH mode), runs the package's
introspection queries against `pg_catalog`/`information_schema`, and renders the
requested language locally. `--query-timeout` is applied as the session's
`statement_timeout` (the flag wins over a DSN `statement_timeout`) and as a
client-side bound around `introspect()`; `0` disables both. When the connection
string carries no explicit `connect_timeout`, a positive `--query-timeout` is
also used as the connect timeout — `0` leaves the driver's default (10s remote,
2s local). `--local` connects to the host-mapped database port from
`supabase/config.toml` (`db.port`).

For a remote target whose DSN carries no explicit `sslmode`, a raw TCP
`SSLRequest` probe (the shared pg-delta probe, default 10s timeout) is opened
to the target host/port first: a server that does not speak SSL is connected
with `sslmode=disable`, so plain-TCP databases (common when self-hosting)
keep working as they did with pg-meta. A server that speaks TLS is connected
with `sslmode=require` plus the embedded Supabase CA bundle (the driver
promotes `require` + a root cert to `verify-ca`), matching the retired
`PG_META_DB_SSL_ROOT_CERT` injection. A probe failure keeps the driver's TLS
default and lets the connection attempt surface the real error. An explicit
`sslmode` on the DSN skips the probe entirely. If `sslmode` is omitted, a
successful TLS probe replaces any DSN/`PGSSLROOTCERT` `sslrootcert` with the
embedded bundle.

`--network-id` / `SUPABASE_NETWORK_ID` are unused: generation no longer runs
inside a container, so a hostname reachable only on a Docker network will not
resolve. `--local` uses the published host port instead; `--db-url` must be
host-reachable.

## Subprocesses

| Command                                                      | When      | Purpose                            |
| ------------------------------------------------------------ | --------- | ---------------------------------- |
| `docker`/`podman container inspect supabase_db_<project_id>` | `--local` | assert `supabase start` is running |

Type generation itself runs no subprocess and pulls no container image.

## Environment Variables

| Variable                                                                                                                                                                                                                       | Purpose                                                            | Required?                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                                                                                                                                                                                                        | auth token for linked/project-id mode                              | no (falls back to keyring → `~/.supabase/access-token`)                                                       |
| `SUPABASE_PROJECT_ID`                                                                                                                                                                                                          | local Docker container project ID                                  | no (falls back to the workdir name)                                                                           |
| `SUPABASE_DB_PORT`                                                                                                                                                                                                             | local database port                                                | no (defaults to `54322`)                                                                                      |
| `SUPABASE_DB_MAJOR_VERSION`                                                                                                                                                                                                    | local PostgreSQL major version                                     | no (defaults to `17`)                                                                                         |
| `SUPABASE_API_SCHEMAS`                                                                                                                                                                                                         | local schemas used when `--schema` is omitted                      | no (defaults to `public,graphql_public`)                                                                      |
| `SUPABASE_ENV`                                                                                                                                                                                                                 | selects nested dotenv files for local generation                   | no (defaults to `development`)                                                                                |
| `SUPABASE_PROFILE`                                                                                                                                                                                                             | built-in profile name or YAML file path                            | no (falls back to `~/.supabase/profile` -> `supabase`)                                                        |
| `SUPABASE_DB_PASSWORD`                                                                                                                                                                                                         | database password for `--local` and the `--linked` workdir project | no (defaults to `postgres`; **ignored** for ad-hoc `--project-id`, which always mints a temporary login role) |
| `SUPABASE_SERVICES_HOSTNAME`                                                                                                                                                                                                   | host used for the local database connection                        | no (defaults to `127.0.0.1`)                                                                                  |
| `SUPABASE_NETWORK_ID`                                                                                                                                                                                                          | unused (native generation does not join a Docker network)          | no                                                                                                            |
| libpq vars (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLPASSWORD`, `PGCONNECT_TIMEOUT`, `PGSERVICE`, `PGSERVICEFILE`, `PGPASSFILE`, `PGAPPNAME`, …) | `--db-url` connection fallbacks, service/passfile, and TLS files   | no                                                                                                            |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success — types printed to stdout                                |
| `1`  | no target specified (must use one flag)                          |
| `1`  | mutually exclusive flags combined (all four Go flag groups)      |
| `1`  | `--postgrest-v9-compat` used without `--db-url`                  |
| `1`  | invalid `--query-timeout` duration or invalid `--db-url`         |
| `1`  | `supabase start` not running (`--local`) or db inspection failed |
| `1`  | API error, connection failure, or introspection/generation error |

## Output

### `--output-format text`

Prints generated TypeScript (or other language) type definitions to stdout,
followed by a single trailing newline (the same shape the retired pg-meta
container produced via `console.log`). Diagnostics (`Connecting to …`) go to
stderr.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Exactly one of `--local`, `--linked`, `--project-id`, or `--db-url` must be specified.
  All four mutually exclusive flag groups are enforced with the exact error text and
  sorted group order: `local/linked/project-id/db-url`, plus `linked/project-id` against
  each of `postgrest-v9-compat`, `query-timeout`, and `swift-access-control`.
- With `--local`, a missing `supabase/config.toml` uses the embedded config defaults plus
  shell and nested dotenv overrides, matching the legacy CLI.
- **Sanctioned intentional divergence (CLI-1988 parity ruling):**
  `--lang` accepts `typescript` (default), `go`, `swift`, or `python`. Project-ref paths
  (`--linked`, `--project-id`, and the implicit linked fallback) use the Management API
  for TypeScript, and generate natively against the project database (temporary
  login-role credentials, preview-branch fallback) for the other languages. The old Go
  CLI instead hard-errored with `Unable to generate <lang> types for selected project.
Try using --db-url flag instead.` and never generated from a project ref. This
  permissiveness is deliberate — it resolves the user-filed CLI-1623 complaint — and was
  blessed in the CLI-1988 ruling; do not revert it to a hard error. The mutex groups only
  block `--swift-access-control` / `--query-timeout` when `--linked`/`--project-id` is
  passed _explicitly_ on the command line — that combination still always generates with
  defaults (`internal` access control, one-to-one detection on, 15s timeout). On the
  **implicit** linked fallback (none of `--local`/`--linked`/`--project-id`/`--db-url`
  passed), neither mutex key is set, so `--swift-access-control public` /
  `--query-timeout 20s` clear every guard and ARE honored for `--lang
go`/`--lang swift`/`--lang python` — the defaults-only claim above holds only for the
  explicit `--linked`/`--project-id` paths. `--postgrest-v9-compat` is unaffected by this
  corner: its own gate requires `--db-url` regardless of how the project ref is resolved,
  so it stays blocked on every project-ref path. Use `--db-url` for guaranteed control
  over any of these three flags.
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- `--swift-access-control` accepts `internal` (default) or `public`. It is
  mutually exclusive with an _explicit_ `--linked`/`--project-id`; on the `--local`,
  `--db-url`, and implicit-linked-fallback paths it is always forwarded to the
  generator regardless of `--lang`.
- `--postgrest-v9-compat` generates types compatible with PostgREST v9 and below
  (one-to-one relationship detection disabled in the TypeScript generator).
  It must be used together with `--db-url` (error:
  `--postgrest-v9-compat must used together with --db-url` — note the typo, preserved
  intentionally). `--local` still forces v9 compat when the local PostgREST image tag
  contains `v9`.
- `--query-timeout` sets the maximum timeout for the introspection queries (default
  15s). It is mutually exclusive with an _explicit_ `--linked`/`--project-id`; on
  the implicit linked fallback it is accepted, and honored for
  `--lang go`/`--lang swift`/`--lang python` (silently unused only for the implicit
  linked TypeScript case, since that path never opens a database connection).
- `--db-url` is parsed by the shared connection resolver (libpq keywords, `PG*` env
  fallbacks, `options=reference=<ref>` pooler tenants, `sslmode`), matching every
  other `--db-url` command.
- The legacy positional language argument (`supabase gen types typescript`) is still accepted;
  any other positional language requires an explicit `--lang` flag.
- Go and Python output now lists entities in the canonical sorted order
  (`sortGeneratorMetadata`) instead of pg-meta's environment-dependent SQL row
  order; the rendered content is otherwise identical (Swift verified
  byte-identical — its template sorts internally). TypeScript is formatted by
  oxfmt (postgrest-typegen ≥ 0.2.0) instead of pg-meta's prettier: content is
  identical, with minor whitespace differences in how long union types wrap.
- The linked-project telemetry cache is written only when a project ref is resolved
  (`--linked`/`--project-id`/fallback) — it's skipped when no ref is available.

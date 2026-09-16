# `supabase gen types`

Generates PostgREST client types in-process via `@supabase/postgrest-typegen`
against a direct PostgreSQL connection. `--linked`/`--project-id` TypeScript
output still comes from the Management API; every other language and target
(including `--local` and `--db-url`) connects to the database and introspects
it directly — no pg-meta container is involved. When `[experimental].stack`
is on, `--local` resolves the project stack through `DbConfigResolver`
(`connType: "local"`) instead of inspecting `supabase_db_*`.

## Files Read

| Path                                              | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                        | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--project-id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/config.toml` or `config.json` | TOML/JSON  | when selecting schemas (`--linked`, `--project-id`, `--db-url`, and the implicit linked fallback — but not when `--schema` is also given on the two flag paths, which skip the load entirely). `--local` reads config.toml through its own tolerant reader (`readDbToml`) and always keeps the embedded-default fallback when the file is absent. On the other paths, a DEFAULTED workdir also keeps the embedded-default fallback (`included_schemas` falls back to `public,graphql_public`); an EXPLICIT `--workdir`/`SUPABASE_WORKDIR` that holds no project instead FAILS (`GenTypesMissingProjectConfigError`) rather than silently generating a `public`-only types file — see the exit-code table |
| `<workdir>{/supabase}/.env*`                      | dotenv     | `--local`; resolves the same nested environment overrides as the CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `<workdir>/supabase/.temp/rest-version`           | plain text | `--local` only, when `db.major_version > 14` — forces v9 compat if the tag contains `v9`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

No files are written.

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
host/port and credentials for the direct connection. Otherwise the database
connection is resolved for the ref and the login-role endpoint supplies temporary
credentials. On an IPv4-only network where the direct database host is unreachable,
project-ref generation retries once through the IPv4 pooler only when the current
target host is the project's direct `db.<ref>` host and the pooler URL matches the
expected tenant and pooler domain. An explicit `--project-id` ref fetches the
primary pooler config for that ref to build the fallback connection (the saved
workdir `.temp/pooler-url` is ignored because the ref may differ from the linked
workdir). `--local` and `--db-url` do not call the Management API.

## Subprocesses

| Command                                                      | When                                                                                                      | Purpose                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `docker`/`podman container inspect supabase_db_<project_id>` | `--local`, only when the selected backend is the legacy Docker Compose stack (`[experimental].stack` off) | assert `supabase start` is running |

Generation itself runs in-process and never shells out. On a native or
Docker-based managed stack (`[experimental].stack` on), `--local` never
inspects a container; it resolves the stack's database connection through
`DbConfigResolver` the same way `--db-url` does.

## Environment Variables

| Variable                     | Purpose                                                                                          | Required?                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for linked/project-id mode                                                            | no (falls back to keyring → `~/.supabase/access-token`)                                                                                                                      |
| `SUPABASE_PROJECT_ID`        | local Docker container and network project ID                                                    | no (falls back to the workdir name)                                                                                                                                          |
| `SUPABASE_DB_PORT`           | local database port                                                                              | no (defaults to `54322`)                                                                                                                                                     |
| `SUPABASE_DB_MAJOR_VERSION`  | local PostgreSQL major version                                                                   | no (defaults to `17`)                                                                                                                                                        |
| `SUPABASE_API_SCHEMAS`       | local schemas used when `--schema` is omitted                                                    | no (defaults to `public,graphql_public`)                                                                                                                                     |
| `SUPABASE_ENV`               | selects nested dotenv files for local generation                                                 | no (defaults to `development`)                                                                                                                                               |
| `SUPABASE_PROFILE`           | built-in profile name or YAML file path                                                          | no (falls back to `~/.supabase/profile` -> `supabase`)                                                                                                                       |
| `SUPABASE_DB_PASSWORD`       | database password for `--local` and the `--linked` workdir project                               | no (defaults to `postgres`; **ignored** for ad-hoc `--project-id`, which always mints a temporary login role)                                                                |
| `SUPABASE_SERVICES_HOSTNAME` | host used to reach the local database on the legacy Docker Compose stack                         | no (defaults to `127.0.0.1`)                                                                                                                                                 |
| `SUPABASE_WORKDIR`           | working directory `supabase/config.toml`/`config.json` is read from (`--workdir` takes priority) | no — when unset, the CLI walks up from cwd looking for `supabase/config.toml`; when SET (flag or env) the directory is used exactly as given and **no ancestor is searched** |

## Exit Codes

| Code | Condition                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — types printed to stdout                                                                                                                                                                     |
| `1`  | no target specified (must use one flag)                                                                                                                                                               |
| `1`  | mutually exclusive flags combined (all four Go flag groups)                                                                                                                                           |
| `1`  | `--postgrest-v9-compat` used without `--db-url`                                                                                                                                                       |
| `1`  | invalid `--query-timeout` duration or invalid `--db-url`                                                                                                                                              |
| `1`  | `--network-id` set (`GenTypesNetworkIdUnsupportedError`) — generation runs in-process and cannot join a Docker network                                                                                |
| `1`  | `supabase start` not running (`--local` on the legacy Docker Compose stack) or db inspection failed                                                                                                   |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`GenTypesWorkdirError`) — beats every other guard                                                                         |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` holds no project config on a schema-selecting path (`GenTypesMissingProjectConfigError`) — a DEFAULTED workdir keeps the embedded-default fallback instead |
| `1`  | API error or database connection/introspection/generation failure (`GenTypesGenerationError`)                                                                                                         |

## Output

### `--output-format text`

Prints generated TypeScript (or other language) type definitions to stdout.
Diagnostics (`Connecting to …`) go to stderr.

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
  shell and nested dotenv overrides, matching the CLI.
- `--network-id` is rejected on this command: generation runs in-process over a direct
  PostgreSQL connection, and there is no container to join a Docker network from. Use a
  host-reachable `--db-url` instead.
- **TLS.** There is no SSL probe on any path.
  - `--linked` / `--project-id` / the implicit linked fallback / a resolved preview
    branch connect with `sslmode=require` and the bundled Supabase CA pinned
    (promoted to `verify-ca`), matching prior behavior.
  - `--db-url` honors the DSN's own `sslmode`/`sslrootcert` when either is set;
    otherwise, a known Supabase host gets the Supabase CA pinned the same way, and any
    other host uses the connection resolver's default.
  - `--local` uses no TLS.
- **Sanctioned intentional divergence (CLI-1988 parity ruling):**
  `--lang` accepts `typescript` (default), `go`, `swift`, or `python`. Project-ref paths
  (`--linked`, `--project-id`, and the implicit linked fallback) use the Management API
  for TypeScript, and connect directly to the project database (temporary
  login-role credentials, preview-branch fallback) for the other languages. The old Go
  CLI instead hard-errored with `Unable to generate <lang> types for selected project.
Try using --db-url flag instead.` and never generated types locally for a project ref.
  This permissiveness is deliberate — it resolves the user-filed CLI-1623 complaint — and
  was blessed in the CLI-1988 ruling; do not revert it to a hard error. The mutex groups
  only block `--swift-access-control` / `--query-timeout` when `--linked`/`--project-id`
  is passed _explicitly_ on the command line — that combination still always generates
  with defaults (`internal` access control, one-to-one detection on, 15s timeout). On the
  **implicit** linked fallback (none of `--local`/`--linked`/`--project-id`/`--db-url`
  passed), neither mutex key is set, so `--swift-access-control public` /
  `--query-timeout 20s` clear every guard and ARE applied for `--lang
go`/`--lang swift`/`--lang python` — the defaults-only claim above holds only for the
  explicit `--linked`/`--project-id` paths. `--postgrest-v9-compat` is unaffected by this
  corner: its own gate requires `--db-url` regardless of how the project ref is resolved,
  so it stays blocked on every project-ref path. Use `--db-url` for guaranteed control
  over any of these three flags.
- **Output compatibility with the previous pg-meta-based generator.** Measured against
  pg-meta's reference generators on the same schema:
  - Go and Swift output are byte-identical.
  - TypeScript: a `NOT NULL` jsonb column now generates `NonNullable<Json>` instead of
    `Json` — the old type wrongly admitted `null` on a column the schema declares
    non-nullable.
  - Python: jsonb columns now generate `JsonValue` instead of pydantic's `Json[Any]`,
    which expected an unparsed JSON _string_ rather than the already-decoded row value
    typegen produces; `NotRequired` and `TypeAlias` are now imported from
    `typing_extensions` instead of `typing`.
  - `--linked`/`--project-id` TypeScript is still generated server-side by the
    Management API and is unaffected by this change, so it can differ from local output
    on these jsonb cases until the hosted service adopts the same generator.
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- `--swift-access-control` accepts `internal` (default) or `public`. It is
  mutually exclusive with an _explicit_ `--linked`/`--project-id`; on the `--local`,
  `--db-url`, and implicit-linked-fallback paths it is always applied
  regardless of `--lang`.
- `--postgrest-v9-compat` generates types compatible with PostgREST v9 and below.
  It must be used together with `--db-url` (error:
  `--postgrest-v9-compat must used together with --db-url` — note the typo, preserved
  intentionally). `--local` still forces v9 compat when the local PostgREST image tag
  contains `v9`.
- `--query-timeout` sets the maximum time allowed for introspection (default 15s),
  applied both as the connection's server-side `statement_timeout` and as a connect
  timeout. It is mutually exclusive with an _explicit_ `--linked`/`--project-id`; on
  the implicit linked fallback it is accepted and applied for
  `--lang go`/`--lang swift`/`--lang python` (silently unused only for the implicit
  linked TypeScript case, since that path never connects to the database directly).
- The legacy positional language argument (`supabase gen types typescript`) is still accepted;
  any other positional language requires an explicit `--lang` flag.
- The linked-project telemetry cache is written only when a project ref is resolved
  (`--linked`/`--project-id`/fallback) — it's skipped when no ref is available.

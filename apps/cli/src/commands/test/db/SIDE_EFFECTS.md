# `supabase test db [path...]`

Runs pgTAP tests against a database. With no target flag the command follows the workspace target
(`SUPABASE_TARGET`, then `target` in `config.toml`, default `local`; see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md)).
`--local` selects the local stack, `--linked` or `--project-ref` the linked project, and `--db-url`
a custom database. The run enables pgTAP and drops it again, so a hosted target (linked project or
remote `--db-url`) asks for one confirmation before anything runs; the local stack never prompts.

## Files Read

| Path                                   | Format | When                                                                                                                                         |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<cwd>/supabase/tests/**/*.{sql,pg}`   | SQL    | default test discovery when no `[path]` given                                                                                                |
| `<path...>`                            | SQL    | when explicit test files/dirs are passed                                                                                                     |
| `<workdir>/supabase/config.toml`       | TOML   | always: `db.port`, `db.shadow_port`, `db.password`, `project_id`. Absent → defaults; **present but malformed → command fails**               |
| `<workdir>/supabase/.temp/pooler-url`  | text   | linked-target pooler fallback only — the connection-pooler URL written by `supabase link` (read from this file rather than from config.toml) |
| `~/.supabase/access-token`             | text   | a linked target only, when `SUPABASE_ACCESS_TOKEN` unset                                                                                     |
| `<workdir>/supabase/.temp/project-ref` | text   | a linked target only, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                                    |
| `<supabaseHome>/stacks/*/state.json`   | JSON   | managed `--local`: discover the project stack and open its saved definition                                                                  |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Database

| Statement                                                     | When                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `select 1 from pg_extension where extname = 'pgtap'`          | always, before enabling — pre-existence check (by extension name, any schema); on a hosted target only after the confirmation |
| `set session role postgres`                                   | after connect when the user is `supabase_admin` / `cli_login_*` (remote linked temp role)                                     |
| `create extension if not exists pgtap with schema extensions` | always, before running tests                                                                                                  |
| `drop extension if exists pgtap`                              | only if pgTAP did not already exist; failure is logged to stderr, non-fatal                                                   |

## Docker

Compose `--local` / `--linked` / `--db-url` run one-shot `docker run --rm <pg_prove image>`, where the image is `supabase/pg_prove:3.36` resolved through the registry (`getRegistryImageUrl`): `SUPABASE_INTERNAL_IMAGE_REGISTRY` overrides the registry, `docker.io` pulls from Docker Hub unchanged, and the default is `public.ecr.aws/supabase/pg_prove:3.36`.

Managed stack `--local` prove runs the catalog `pg_prove` tool through the owning stack runtime with runtime-facing host and port, preserving the CLI resolver’s database user, password, and database. External `--db-url`/`--linked` prove uses the catalog Postgres client: native prepends `artifact/bin`; container or no-native-artifact platforms run a one-shot of the digest-pinned catalog Postgres image. That pin is not rewritten through `SUPABASE_INTERNAL_IMAGE_REGISTRY`. Missing `pg_prove` fails closed. There is no PATH fallback.

- `-v <hostpath>:<dockerpath>:ro` for each test path on Compose and on catalog container prove. A path that is a **file** is mounted via its **containing directory** (not the lone file) so that psql `\ir`/`\i` includes — which resolve relative to the test file's own directory — find their sibling files inside the container (CLI-1139). Directory paths are mounted as-is. Mounts are deduped by container target, so multiple files in the same directory produce a single `-v`. The full file path is still passed to `pg_prove`, so only the requested file runs. Native prove reads host paths directly (no bind).
- `--security-opt label:disable` on Compose and catalog container prove (omitted in Bitbucket Pipelines)
- `--network supabase_network_<project_id>` (Compose `--local`) with env `PGHOST=db PGPORT=5432`. External `--db-url`/`--linked` runs use host networking with the resolved host and port. Managed stack proves use the owner-managed tool with runtime credentials and its runtime-specific attachment; they do not use the Compose network or `PGHOST=db`. `<project_id>` is sanitized (`sanitizeProjectId`), so an invalid configured value (e.g. `"my project"`) joins the same network the local stack created
- `-e PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`
- cmd `pg_prove --ext .pg --ext .sql -r <paths> [--verbose]` (`--verbose` when `--debug`)

## API Routes (linked target only)

| Method | Path                                | Auth         | Request body                              | Response (used fields)      |
| ------ | ----------------------------------- | ------------ | ----------------------------------------- | --------------------------- |
| POST   | `/v1/projects/{ref}/cli/login-role` | access token | `{ read_only: false }`                    | `{ role, password }`        |
| GET    | `/v1/projects/{ref}/network-bans`   | access token | —                                         | `{ banned_ipv4_addresses }` |
| DELETE | `/v1/projects/{ref}/network-bans`   | access token | `{ ipv4_addresses, requester_ip: false }` | —                           |

## Environment Variables

| Variable                     | Purpose                                                                        | Required?                                     |
| ---------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `SUPABASE_DB_PASSWORD`       | linked target: skip temporary login-role creation                              | no                                            |
| `SUPABASE_ACCESS_TOKEN`      | linked target: Management API auth                                             | no (falls back to keyring/file)               |
| `SUPABASE_TARGET`            | workspace target when no `--local`/`--linked`/`--db-url` is given              | no (→ `target` in `config.toml` → `local`)    |
| `SUPABASE_YES`               | grants the hosted-target confirmation (shell only; `supabase/.env` is ignored) | no (also `--yes`)                             |
| `SUPABASE_SERVICES_HOSTNAME` | `--local`: overrides the local DB host (dev-container/remote Docker)           | no (defaults via `DOCKER_HOST` → `127.0.0.1`) |
| `DOCKER_HOST`                | `--local`: tcp daemon host used when no services-hostname override             | no                                            |
| `BITBUCKET_CLONE_DIR`        | when set, omit `--security-opt label:disable` (Bitbucket rejects it)           | no                                            |
| `DEBUG` / `--debug`          | append `--verbose` to `pg_prove`                                               | no                                            |

## Exit Codes

| Code | Condition                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | all pgTAP tests pass                                                                                                                                            |
| `1`  | `pg_prove` exits non-zero (test failures) — `error running container: exit N`, or `error running pg_prove: exit N` on a managed stack or native external client |
| `1`  | `pg_prove` ran no tests (`Result: NOTESTS`) — `no pgTAP tests found in <paths>`                                                                                 |
| `1`  | more than one of `--db-url` / `--linked` / `--local` (`TargetSelectorConflictError`)                                                                            |
| `1`  | database connection failure / pgTAP enable failure / docker failure / linked-target auth or IPv6 errors                                                         |
| `1`  | `--project-ref` with `--local` or `--db-url` (`TargetProjectRefConflictError`)                                                                                  |
| `1`  | hosted target in a JSON, piped, agent or non-TTY run without `--yes` or a shell `SUPABASE_YES` (`HostedMutationConsentRequiredError`); nothing runs             |
| `1`  | hosted target confirmation declined (`HostedMutationDeclinedError`, `context canceled`); nothing runs                                                           |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                     |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`, **`command: "test db"`** — not `"db test"` |

`db test` (`../../db/test/`) is a hidden alias that reuses this
command's flag config and handler verbatim, but records `command: "db test"`
instead, since each command's own telemetry wrapper records its own invocation
path even though the underlying handler is the same function. Driven by
`commandPath` in `../../../command-internal/test-db.layers.ts`'s
`testDbRuntimeLayer` factory — each `.command.ts` passes its own actual
invocation path.

## Output

`pg_prove`'s TAP output streams to **stdout in every output format** (the docker
subprocess's stdout is forwarded chunk-by-chunk, byte-exact and unframed) —
`test db` is a live test stream with no structured equivalent.

### `--output-format text`

TAP streams to stdout. The `Target: …` line (linked project `Target: <name> (<ref>)`,
`Target: local stack (<host>:<port>)`, or `Target: custom Postgres (<host>)`) and the hosted
confirmation question are written to **stderr**, never to stdout — no
spinner is used, so stdout carries only the raw TAP bytes.

### `--output-format json` / `stream-json`

No machine envelope is emitted. stdout carries the raw TAP stream only; the
target line still goes to stderr (no task JSON-log events are written to stdout,
which would otherwise corrupt the TAP stream). A non-zero `pg_prove` exit still fails the
command (exit 1).

## Notes

- Hidden command.
- Stack `test db` runs catalog `pg_prove` through the owning stack runtime with runtime credentials for native and container runtimes. External targets use the catalog Postgres client. Compose stays on `supabase/pg_prove:3.36`. There is no PATH fallback or host major-version check.
- **Target selection** (shared by `db test` via `testDbConfig`). `--db-url`, `--linked` and
  `--local` are mutually exclusive and a `false` switch counts as absent. `--project-ref` selects
  the linked project and supplies only the ref (flag > `SUPABASE_PROJECT_ID` >
  `.temp/project-ref`); combining it with `--local` or `--db-url` is a hard error.
- **Hosted consent.** A linked project or remote `--db-url` asks once, after the target and the
  test paths are resolved and before pgTAP is enabled: `Run pgTAP tests`, listing the pgTAP
  enable, the `pg_prove` run against the test paths, and the pgTAP drop, with default No. A
  shell `SUPABASE_YES` or `--yes` grants it (`Confirmed by --yes: …`); a `SUPABASE_YES` in
  `supabase/.env` and a piped answer do not. Stdin is never read for the answer. A `--db-url`
  that points at the local stack never prompts.
- Postgres TLS behavior: local connections disable TLS
  (`ConnectLocalPostgres` sets `cc.TLSConfig = nil`); remote (`--db-url` / `--linked`)
  connections honor the URL's `sslmode` —
  `disable` → plaintext, `verify-ca` / `verify-full` → TLS **with** certificate
  verification, and everything else (`prefer` / `require` / unset) → TLS **without**
  verification (non-TLS fallbacks stripped).
- `--db-url` accepts both the WHATWG `postgres(ql)://…` URL form and the libpq
  keyword/value DSN form (`host=… dbname=… user=…`, incl. unix-socket paths), following libpq parsing. The `sslmode` and libpq `options` (Supavisor
  `?options=reference=<ref>`) parameters are preserved on both forms. A malformed URL or
  percent escape surfaces as a redacted `failed to parse connection string` error, never
  an unhandled defect.
- Multi-host failover connection strings (`postgres://h1:5432,h2:5433/db`,
  `host=h1,h2 port=5432,5433`) are supported on both forms, following libpq's
  connection-string handling: the primary host is dialed first, then each fallback in order,
  reusing the first port when a host omits one.
- Password precedence matches libpq semantics: a password supplied by
  the connection string — **even an explicit empty one** (`user:@host`, `?password=`,
  `password=`) — overrides `PGPASSWORD`; an empty resolved value then falls through to
  `.pgpass`. A connection string with no password key at all uses `PGPASSWORD` then
  `.pgpass`.
- `--dns-resolver https` (global flag): for remote connections
  the DB host is resolved via Cloudflare DNS-over-HTTPS (`https://1.1.1.1/dns-query`)
  before dialing. TLS verification still targets the original hostname (via
  `ssl.servername`). The native resolver is used for local connections and when the
  flag is `native` (the default).
- Postgres access uses `@effect/sql-pg`, which does not expose server notices (such as
  code 42710 `duplicate_object`), so "pgTAP already installed" is detected by checking
  `pg_extension` by extension name (any schema) before enabling — including when the user pre-installed pgTAP in a non-`extensions`
  schema such as `public`.
- The linked connection pooler URL is read from `supabase/.temp/pooler-url` (written by
  `supabase link`) rather than from config.toml — the `[db.pooler]` config.toml field
  is intentionally ignored. The pooler's `?options=reference=<ref>` startup param is
  carried through to the connection for the legacy pooler-URL format.
- Compose pg_prove image is fixed at `supabase/pg_prove:3.36`; there is no `[images] pgprove`
  config override in the TS config schema.
- There is no command-local `--network-id` flag; the global `--network-id` flag selects the
  tool container's network.

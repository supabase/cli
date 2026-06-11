# `supabase test db [path...]`

## Files Read

| Path                                  | Format | When                                                                                                                                                       |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<cwd>/supabase/tests/**/*.{sql,pg}`  | SQL    | default test discovery when no `[path]` given                                                                                                              |
| `<path...>`                           | SQL    | when explicit test files/dirs are passed                                                                                                                   |
| `<workdir>/supabase/config.toml`      | TOML   | always: `db.port`, `db.shadow_port`, `db.password`, `project_id`. Absent → defaults; **present but malformed → command fails** (Go's `config.Load` parity) |
| `<workdir>/supabase/.temp/pooler-url` | text   | `--linked` pooler fallback only — the connection-pooler URL written by `supabase link` (Go reads it here, not from config.toml)                            |
| `~/.supabase/access-token`            | text   | `--linked` only, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                        |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Database

| Statement                                                     | When                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `select 1 from pg_extension where extname = 'pgtap'`          | always, before enabling — pre-existence check (by extension name, any schema)             |
| `set session role postgres`                                   | after connect when the user is `supabase_admin` / `cli_login_*` (remote linked temp role) |
| `create extension if not exists pgtap with schema extensions` | always, before running tests                                                              |
| `drop extension if exists pgtap`                              | only if pgTAP did not already exist; failure is logged to stderr, non-fatal               |

## Docker

One-shot `docker run --rm <pg_prove image>`, where the image is `supabase/pg_prove:3.36` resolved through the registry (`legacyGetRegistryImageUrl`, mirroring Go's `GetRegistryImageUrl`): `SUPABASE_INTERNAL_IMAGE_REGISTRY` overrides the registry, `docker.io` pulls from Docker Hub unchanged, and the default is `public.ecr.aws/supabase/pg_prove:3.36`.

- `-v <hostpath>:<dockerpath>:ro` for each test path
- `--security-opt label:disable`
- `--network supabase_network_<project_id>` (local) with env `PGHOST=db PGPORT=5432`, or `--network host` (db-url / linked) with the resolved host/port. `<project_id>` is sanitized exactly as Go's `config.Load` does (`sanitizeProjectId`), so an invalid configured value (e.g. `"my project"`) joins the same network the local stack created
- `-e PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`
- cmd `pg_prove --ext .pg --ext .sql -r <paths> [--verbose]` (`--verbose` when `--debug`)

## API Routes (`--linked` only)

| Method | Path                                | Auth         | Request body                              | Response (used fields)      |
| ------ | ----------------------------------- | ------------ | ----------------------------------------- | --------------------------- |
| POST   | `/v1/projects/{ref}/cli/login-role` | access token | `{ read_only: false }`                    | `{ role, password }`        |
| GET    | `/v1/projects/{ref}/network-bans`   | access token | —                                         | `{ banned_ipv4_addresses }` |
| DELETE | `/v1/projects/{ref}/network-bans`   | access token | `{ ipv4_addresses, requester_ip: false }` | —                           |

## Environment Variables

| Variable                     | Purpose                                                              | Required?                                     |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| `SUPABASE_DB_PASSWORD`       | `--linked`: skip temporary login-role creation                       | no                                            |
| `SUPABASE_ACCESS_TOKEN`      | `--linked`: Management API auth                                      | no (falls back to keyring/file)               |
| `SUPABASE_SERVICES_HOSTNAME` | `--local`: overrides the local DB host (dev-container/remote Docker) | no (defaults via `DOCKER_HOST` → `127.0.0.1`) |
| `DOCKER_HOST`                | `--local`: tcp daemon host used when no services-hostname override   | no                                            |
| `BITBUCKET_CLONE_DIR`        | when set, omit `--security-opt label:disable` (Bitbucket rejects it) | no                                            |
| `DEBUG` / `--debug`          | append `--verbose` to `pg_prove`                                     | no                                            |

## Exit Codes

| Code | Condition                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | all pgTAP tests pass                                                                                 |
| `1`  | `pg_prove` exits non-zero (test failures) — `error running container: exit N`                        |
| `1`  | `--db-url` / `--linked` / `--local` set together (mutually exclusive)                                |
| `1`  | database connection failure / pgTAP enable failure / docker failure / `--linked` auth or IPv6 errors |

## Output

`pg_prove`'s TAP output streams to **stdout in every output format** (the docker
subprocess inherits stdout), exactly as the Go CLI does — `test db` is a live test
stream with no structured equivalent.

### `--output-format text` (Go CLI compatible)

TAP streams to stdout. The connection diagnostic `Connecting to {local|remote} database...`
is written to **stderr** (matching Go's `ConnectByConfigStream`), never to stdout — no
spinner is used, so stdout carries only the raw TAP bytes.

### `--output-format json` / `stream-json`

No machine envelope is emitted (Go has none). stdout carries the raw TAP stream only; the
connection diagnostic still goes to stderr (no task JSON-log events are written to stdout,
which would otherwise corrupt the TAP stream). A non-zero `pg_prove` exit still fails the
command (exit 1).

## Notes

- Native TypeScript port (Phase 1+); no Go proxy. Hidden command (matches Go).
- Postgres TLS matches Go (`internal/utils/connect.go`): local connections disable TLS
  (`ConnectLocalPostgres` sets `cc.TLSConfig = nil`); remote (`--db-url` / `--linked`)
  connections honor the URL's `sslmode` (`pgconn.ParseConfig` → `ConnectByUrl`) —
  `disable` → plaintext, `verify-ca` / `verify-full` → TLS **with** certificate
  verification, and everything else (`prefer` / `require` / unset) → TLS **without**
  verification (pgx's default for `prefer`/`require`, non-TLS fallbacks stripped).
- `--db-url` accepts both the WHATWG `postgres(ql)://…` URL form and the libpq
  keyword/value DSN form (`host=… dbname=… user=…`, incl. unix-socket paths), matching
  Go's `pgconn.ParseConfig`. The `sslmode` and libpq `options` (Supavisor
  `?options=reference=<ref>`) parameters are preserved on both forms. A malformed URL or
  percent escape surfaces as a redacted `failed to parse connection string` error, never
  an unhandled defect.
- Multi-host failover connection strings (`postgres://h1:5432,h2:5433/db`,
  `host=h1,h2 port=5432,5433`) are supported on both forms, matching pgconn
  (`config.go:326-362`): the primary host is dialed first, then each fallback in order,
  reusing the first port when a host omits one.
- Password precedence matches pgconn/libpq (`config.go:264-379`): a password supplied by
  the connection string — **even an explicit empty one** (`user:@host`, `?password=`,
  `password=`) — overrides `PGPASSWORD`; an empty resolved value then falls through to
  `.pgpass`. A connection string with no password key at all uses `PGPASSWORD` then
  `.pgpass`.
- `--dns-resolver https` (global flag, Go's `utils.DNSResolver`): for remote connections
  the DB host is resolved via Cloudflare DNS-over-HTTPS (`https://1.1.1.1/dns-query`)
  before dialing, mirroring Go's `cc.LookupFunc = FallbackLookupIP` (`connect.go:211`).
  TLS verification still targets the original hostname (via `ssl.servername`). The native
  resolver is used for local connections and when the flag is `native` (the default).
- Postgres access uses `@effect/sql-pg`. Go detects "pgTAP already installed" via a
  `pgx` `OnNotice` (code 42710 `duplicate_object`) callback, which `@effect/sql-pg`
  does not expose; the port instead checks `pg_extension` by extension name (any
  schema) before enabling — same observable drop-skip behavior, including when the
  user pre-installed pgTAP in a non-`extensions` schema such as `public`.
- The linked connection pooler URL is read from `supabase/.temp/pooler-url` (written by
  `supabase link`), matching Go — the `[db.pooler]` config.toml field is `toml:"-"` in Go
  and is intentionally ignored. The pooler's `?options=reference=<ref>` startup param is
  carried through to the connection for the legacy pooler-URL format.
- pg_prove image is fixed at `supabase/pg_prove:3.36`; Go's `[images] pgprove` config
  override is not modeled by the TS config schema (documented divergence).
- Go's hidden `--network-id` override is not declared on the TS command (documented divergence).

# `supabase test db [path...]`

## Files Read

| Path                                 | Format | When                                                                                                       |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| `<cwd>/supabase/tests/**/*.{sql,pg}` | SQL    | default test discovery when no `[path]` given                                                              |
| `<path...>`                          | SQL    | when explicit test files/dirs are passed                                                                   |
| `<workdir>/supabase/config.toml`     | TOML   | always (tolerant): `db.port`, `db.shadow_port`, `db.password`, `db.pooler.connection_string`, `project_id` |
| `~/.supabase/access-token`           | text   | `--linked` only, when `SUPABASE_ACCESS_TOKEN` unset                                                        |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Database

| Statement                                                     | When                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `create extension if not exists pgtap with schema extensions` | always, before running tests                                                |
| `drop extension if exists pgtap`                              | only if pgTAP did not already exist; failure is logged to stderr, non-fatal |

## Docker

One-shot `docker run --rm supabase/pg_prove:3.36`:

- `-v <hostpath>:<dockerpath>:ro` for each test path
- `--security-opt label:disable`
- `--network supabase_network_<project_id>` (local) with env `PGHOST=db PGPORT=5432`, or `--network host` (db-url / linked) with the resolved host/port
- `-e PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`
- cmd `pg_prove --ext .pg --ext .sql -r <paths> [--verbose]` (`--verbose` when `--debug`)

## API Routes (`--linked` only)

| Method | Path                                | Auth         | Request body                              | Response (used fields)      |
| ------ | ----------------------------------- | ------------ | ----------------------------------------- | --------------------------- |
| POST   | `/v1/projects/{ref}/cli/login-role` | access token | `{ read_only: false }`                    | `{ role, password }`        |
| GET    | `/v1/projects/{ref}/network-bans`   | access token | —                                         | `{ banned_ipv4_addresses }` |
| DELETE | `/v1/projects/{ref}/network-bans`   | access token | `{ ipv4_addresses, requester_ip: false }` | —                           |

## Environment Variables

| Variable                | Purpose                                        | Required?                       |
| ----------------------- | ---------------------------------------------- | ------------------------------- |
| `SUPABASE_DB_PASSWORD`  | `--linked`: skip temporary login-role creation | no                              |
| `SUPABASE_ACCESS_TOKEN` | `--linked`: Management API auth                | no (falls back to keyring/file) |
| `DEBUG` / `--debug`     | append `--verbose` to `pg_prove`               | no                              |

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

TAP streams to stdout; connection/enable progress shows as spinners (text mode only).

### `--output-format json` / `stream-json`

No machine envelope is emitted (Go has none). stdout carries the raw TAP stream and
spinners are suppressed; a non-zero `pg_prove` exit still fails the command (exit 1).

## Notes

- Native TypeScript port (Phase 1+); no Go proxy. Hidden command (matches Go).
- Postgres access uses `@effect/sql-pg`. Go detects "pgTAP already installed" via a
  `pgx` `OnNotice` (code 42710) callback, which `@effect/sql-pg` does not expose; the
  port instead checks `pg_extension` before enabling — same observable drop-skip behavior.
- pg_prove image is fixed at `supabase/pg_prove:3.36`; Go's `[images] pgprove` config
  override is not modeled by the TS config schema (documented divergence).
- Go's hidden `--network-id` override is not declared on the TS command (documented divergence).

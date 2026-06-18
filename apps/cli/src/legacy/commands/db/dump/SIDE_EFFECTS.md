# `supabase db dump`

Native TypeScript port (`dump.handler.ts`). Streams a `pg_dump`/`pg_dumpall`
script run inside the local Postgres image to stdout or `--file`.

## Files Read

| Path                              | Format     | When                                                        |
| --------------------------------- | ---------- | ----------------------------------------------------------- |
| `supabase/config.toml`            | TOML       | always (db port/password/major_version, project_id)         |
| `supabase/.temp/postgres-version` | plain text | always (best-effort) — pins the pg image tag when present   |
| `supabase/.temp/pooler-url`       | plain text | `--linked` when the direct host is unreachable (pooler URL) |
| `~/.supabase/access-token`        | plain text | `--linked` when `SUPABASE_ACCESS_TOKEN` unset               |
| `supabase/.env*`                  | dotenv     | always (project env, feeds `SUPABASE_DB_PASSWORD` / `PG*`)  |

## Files Written

| Path                            | Format | When                                                                               |
| ------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `<path>` (from `--file` / `-f`) | SQL    | when `--file` is set and **not** `--dry-run` (created/truncated `0644` before run) |

## API Routes

| Method | Path                                         | Auth   | When                                                         |
| ------ | -------------------------------------------- | ------ | ------------------------------------------------------------ |
| POST   | `/v1/projects/{ref}/cli/login-role`          | Bearer | `--linked` with no `DB_PASSWORD` (mint a temp postgres role) |
| GET    | `/v1/projects/{ref}/network-bans` (+ DELETE) | Bearer | `--linked` pooler temp-role retry (clear self ban)           |

(All via the shared `LegacyDbConfigResolver` `--linked` path.)

## Environment Variables

| Variable                                                                      | Purpose                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `SUPABASE_DB_PASSWORD` (`DB_PASSWORD` viper key; `--password`/`-p` overrides) | remote DB password                            |
| `SUPABASE_ACCESS_TOKEN`                                                       | `--linked` auth                               |
| `BITBUCKET_CLONE_DIR`                                                         | (no-op for dump — no `--security-opt` is set) |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                            | rewrite the pg image registry                 |
| `DOCKER_HOST`                                                                 | docker daemon endpoint                        |

## Exit Codes

| Code | Condition                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                             |
| `1`  | `--use-copy`/`--exclude` without `--data-only`; mutually-exclusive flags; bad `--file` path; connection failure; container exit ≠ 0 |

## Output

SQL goes to **stdout** (or `--file`) in **all** `--output-format` modes — Go has
no `--output-format` for `db dump`, so there is no machine envelope (same
rationale as `test db`). Diagnostics go to **stderr**: `Dumping {schemas|data|
roles} from {local|remote} database...`, the `--dry-run` notice, and the
`Dumped schema to <abs>.` confirmation when `--file` is used. `--dry-run` prints
the env-expanded script to stdout without running a container; with `--file` it
still prints the `Dumped schema to <abs>.` confirmation (Go's PostRun fires on the
successful dry-run) but does **not** create or truncate the file.

On a linked dump whose container fails with an IPv6 connectivity error (no IPv4
pooler retry available, or the retry also fails), the error is followed on stderr by
the IPv4 transaction-pooler suggestion (Go's `SetConnectSuggestion`/`ipv6Suggestion`).

> **Credential warning:** `--dry-run` expands the pg_dump script with live env
> values, so the resolved `PGPASSWORD` (for a remote/linked project, the database
> password) is printed **in cleartext** to stdout. This matches Go's `noExec`
> (`internal/db/dump/dump.go`), but operators piping `--dry-run` output to logs or
> CI artifacts should treat that output as a secret.

## Notes / Divergences

- `--data-only` XOR `--role-only`; `--keep-comments` XOR `--data-only`;
  `--schema` XOR `--role-only`; `--db-url` XOR `--linked` XOR `--local`.
  `--use-copy` / `--exclude` require `--data-only`. `--linked` defaults to true.
- **Container-level pooler fallback is ported** (`RunWithPoolerFallback`,
  `internal/db/dump/pooler_fallback.go`). When a linked dump reaches the direct host
  from the host process but the `pg_dump` container fails over IPv6, the captured
  container stderr is classified (`legacyIsIPv6ConnectivityError`) and the dump is
  retried once through the project's IPv4 transaction pooler
  (`resolver.resolvePoolerFallback`). This is in addition to the resolver's
  connect-time pooler fallback for an unreachable direct host.
  - Remaining divergence: on the no-fallback / failed-retry path, the IPv6
    suggestion uses the generic `ipv6Suggestion()` text rather than Go's
    `SuggestIPv6Pooler`, which prefills the project's specific pooler connection
    string. Surfacing that exact URL needs the pooler string exposed at this seam.

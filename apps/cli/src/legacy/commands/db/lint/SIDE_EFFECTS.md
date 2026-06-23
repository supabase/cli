# `supabase db lint`

Checks a database for PL/pgSQL typing errors via the `plpgsql_check` extension.
Native TypeScript port of Go's `internal/db/lint`.

## Files Read

| Path                             | Format     | When                                                                 |
| -------------------------------- | ---------- | -------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML       | always — to resolve the local / linked DB connection config          |
| `~/.supabase/access-token`       | plain text | `--linked` only, when `SUPABASE_ACCESS_TOKEN` unset (keyring → file) |

## Files Written

| Path                         | Format | When                                                 |
| ---------------------------- | ------ | ---------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always (PostHog state flush, Go `PersistentPostRun`) |

No user data is written: the lint runs inside a transaction that is **always
rolled back** (`BEGIN` … `ROLLBACK`), matching Go — including
`CREATE EXTENSION plpgsql_check`, which is issued on the same connection inside
the open transaction and so is rolled back too. `db lint` does not write the
linked-project cache (it has no `LegacyLinkedProjectCache` dependency).

## API Routes

None called directly. `--linked` resolves the project's direct-DB connection
through the shared db-config resolver (which may call the Management API to
resolve credentials); the lint itself issues no advisor/API requests.

## Database

One connection (local / `--db-url` / linked-direct). Within one transaction:

1. `BEGIN`
2. (when `--schema` is omitted) `ListUserSchemas` — `... not nspname like any($1)` with the managed-schemas array bound as `$1`
3. `CREATE EXTENSION IF NOT EXISTS plpgsql_check`
4. per schema: `SELECT p.proname, plpgsql_check_function(p.oid, format:='json') …` (`templates/check.sql`)
5. `ROLLBACK` (always — lint has no committed effects)

Requires `plpgsql_check` to be installable; a bare vanilla `--db-url` without
the extension fails at step 3 (matching Go).

## Environment Variables

| Variable                | Purpose                                  | Required?                                 |
| ----------------------- | ---------------------------------------- | ----------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` resolution     | no (keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | linked direct-DB password                | no                                        |
| `SUPABASE_PROFILE`      | API profile (built-in name or YAML path) | no                                        |
| `PGHOST` / `PGPORT` / … | connection overrides                     | no                                        |

## Exit Codes

| Code | Condition                                                                  |
| ---- | -------------------------------------------------------------------------- |
| `0`  | success — no issues at or above `--fail-on` (an empty result is still `0`) |
| `1`  | mutually-exclusive `--db-url` / `--linked` / `--local`                     |
| `1`  | connection / `BEGIN` / list-schemas / enable-extension / query failure     |
| `1`  | malformed `plpgsql_check` JSON                                             |
| `1`  | an issue's level is at or above `--fail-on`                                |

## Output

### `--output-format text` (Go CLI compatible)

Diagnostics on **stderr**: `Connecting to <local\|remote> database...`,
`Linting schema: <s>`, and `\nNo schema errors found` (when no issues).
The result is the Go pretty-printed 2-space JSON array on **stdout** (struct-order
keys, `omitempty` fields dropped, trailing newline). A filtered-empty result
writes nothing to stdout (Go parity).

### `--output-format json`

A standard `output.success("db lint", { results })` envelope on stdout
(diagnostics on stderr). Additive — Go has no machine output.

### `--output-format stream-json`

A `result` event carrying `{ results }`. Additive.

When `--fail-on` triggers in a machine format, the result is still emitted and
the process exits non-zero (no error envelope is written over the payload).

## Notes

- `--level` (`warning` default) sets the minimum issue level to emit.
- `--fail-on` (`none` default) sets the level that forces a non-zero exit.
- `--schema` / `-s` restricts linting to specific schemas; omitted ⇒ all user schemas.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- Telemetry: only the standard `cli_command_executed` event (no custom events).

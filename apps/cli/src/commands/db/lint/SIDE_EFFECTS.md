# `supabase db lint`

Checks a database for PL/pgSQL typing errors via the `plpgsql_check` extension.

With no target flag the command follows the workspace target (`SUPABASE_TARGET`, then `target`
in `config.toml`, default `local`; see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md)).
It only reads, so it never asks for confirmation, on any target.

## Files Read

| Path                                   | Format     | When                                                                                                              |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | always — to resolve the local / linked DB connection config                                                       |
| `~/.supabase/access-token`             | plain text | a linked target only, when `SUPABASE_ACCESS_TOKEN` unset (keyring → file)                                         |
| `<workdir>/supabase/.temp/project-ref` | plain text | a linked target only, to resolve the project ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

## Files Written

| Path                                           | Format | When                                                 |
| ---------------------------------------------- | ------ | ---------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | a linked target only, via `LinkedProjectCache.cache` |
| `~/.supabase/telemetry.json`                   | JSON   | always (PostHog state flush)                         |

No user data is written: the lint runs inside a transaction that is **always
rolled back** (`BEGIN` … `ROLLBACK`) — including
`CREATE EXTENSION plpgsql_check`, which is issued on the same connection inside
the open transaction and so is rolled back too. `db lint` DOES write the
linked-project cache when it targets the linked project; the local and
`--db-url` paths never populate a project ref, so no cache write occurs there.

## API Routes

None called directly. A linked target resolves the project's direct-DB connection
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
the extension fails at step 3. Stack catalog Postgres (native artifact and the
digest-pinned image) ships the extension, so `--local` lint on native and
container stacks can enable it. Compose uses the Compose Postgres image.

## Environment Variables

| Variable                | Purpose                                  | Required?                                  |
| ----------------------- | ---------------------------------------- | ------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | auth token for linked-target resolution  | no (keyring → `~/.supabase/access-token`)  |
| `SUPABASE_TARGET`       | workspace target when no target flag set | no (→ `target` in `config.toml` → `local`) |
| `SUPABASE_DB_PASSWORD`  | linked direct-DB password                | no                                         |
| `SUPABASE_PROFILE`      | API profile (built-in name or YAML path) | no                                         |
| `PGHOST` / `PGPORT` / … | connection overrides                     | no                                         |

## Exit Codes

| Code | Condition                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | success — no issues at or above `--fail-on` (an empty result is still `0`)           |
| `1`  | more than one of `--db-url` / `--linked` / `--local` (`TargetSelectorConflictError`) |
| `1`  | connection / `BEGIN` / list-schemas / enable-extension / query failure               |
| `1`  | malformed `plpgsql_check` JSON                                                       |
| `1`  | an issue's level is at or above `--fail-on`                                          |
| `1`  | `--project-ref` with `--local` or `--db-url` (`TargetProjectRefConflictError`)       |

## Output

### `--output-format text`

Diagnostics on **stderr**: the `Target: …` line (linked project `Target: <name> (<ref>)`,
`Target: local stack (<host>:<port>)`, or `Target: custom Postgres (<host>:<port>)`),
`Linting schema: <s>`, and `\nNo schema errors found` (when no issues).
The result is a pretty-printed 2-space JSON array on **stdout** (struct-order
keys, `omitempty` fields dropped, trailing newline). A filtered-empty result
writes nothing to stdout.

### `--output-format json`

A standard `output.success("db lint", { results })` envelope on stdout
(diagnostics on stderr). Additive — there is no other machine output.

### `--output-format stream-json`

A `result` event carrying `{ results }`. Additive.

When `--fail-on` triggers in a machine format, the result is still emitted and
the process exits non-zero (no error envelope is written over the payload).

## Notes

- `--level` (`warning` default) sets the minimum issue level to emit.
- `--fail-on` (`none` default) sets the level that forces a non-zero exit.
- `--schema` / `-s` restricts linting to specific schemas; omitted ⇒ all user schemas.
- **Target selection.** `--db-url`, `--linked` and `--local` are mutually exclusive and a `false`
  switch counts as absent. `--project-ref` selects the linked project and supplies only the ref
  (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`) for the connection and the linked-project
  cache; combining it with `--local` or `--db-url` is a hard error.
- Telemetry: only the standard `cli_command_executed` event (no custom events).

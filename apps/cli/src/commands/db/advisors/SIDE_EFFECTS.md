# `supabase db advisors`

Checks a database for security and performance issues. Two backends: `--local`
/ `--db-url` query the database directly; `--linked` fetches from the
Management API.

## Files Read

| Path                                   | Format     | When                                                                                                         |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`       | TOML       | local / `--db-url` — to resolve the DB connection config                                                     |
| `~/.supabase/access-token`             | plain text | `--linked` only, when `SUPABASE_ACCESS_TOKEN` unset (keyring → file)                                         |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked` only — to resolve the project ref; skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

## Files Written

| Path                                           | Format | When                                                  |
| ---------------------------------------------- | ------ | ----------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (PostHog state flush)                          |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | `--linked` only, via `LegacyLinkedProjectCache.cache` |

The local lint query runs inside a transaction that is **always rolled back**.

## API Routes (`--linked` only)

| Method | Path                                      | Auth   | Request | Response (used fields) |
| ------ | ----------------------------------------- | ------ | ------- | ---------------------- |
| GET    | `/v1/projects/{ref}/advisors/security`    | Bearer | —       | `{ lints: Lint[] }`    |
| GET    | `/v1/projects/{ref}/advisors/performance` | Bearer | —       | `{ lints: Lint[] }`    |

Issued via **raw HTTP** (not the typed client) with a tolerant parse, so advisor
`name` / `metadata.type` values the API can add do not fail decoding. `--type`
selects which endpoints run:
`security` → security only, `performance` → performance only, `all` → both.

## Database (`--local` / `--db-url`)

One connection. Within one transaction: `BEGIN` → `set local search_path = ''`
(setup half of `templates/lints.sql`) → the multi-CTE lints query → `ROLLBACK`.
`--type` filters the resulting rows by category (`SECURITY` / `PERFORMANCE`).

## Environment Variables

| Variable                | Purpose                                                              | Required?                                 |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked`                                            | no (keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | linked project ref override (superseded by `--project-ref` when set) | no                                        |
| `SUPABASE_PROFILE`      | API profile (built-in name or YAML path)                             | no                                        |
| `PGHOST` / `PGPORT` / … | connection overrides (local / `--db-url`)                            | no                                        |

The API base URL is derived from `SUPABASE_PROFILE`; `SUPABASE_API_URL` is **not**
honored (see `legacy-cli-settings.layer.unit.test.ts`).

## Exit Codes

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success — no issues at or above `--fail-on` (empty result is still `0`)  |
| `1`  | mutually-exclusive `--db-url` / `--linked` / `--local`                   |
| `1`  | `--linked` with no access token (suggests `supabase login`)              |
| `1`  | connection / `BEGIN` / setup / query failure (local)                     |
| `1`  | advisors API non-200 (linked)                                            |
| `1`  | a lint's level is at or above `--fail-on`                                |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

Diagnostics on **stderr**: `Connecting to <local\|remote> database...` (local) and
`No issues found` (when no lints). The result is a pretty-printed 2-space
JSON array on **stdout** (struct-order keys, `metadata` omitted when absent,
trailing newline).

### `--output-format json`

A standard `output.success("db advisors", { results })` envelope on stdout
(diagnostics on stderr). Additive — there is no other machine output.

### `--output-format stream-json`

A `result` event carrying `{ results }`. Additive.

When `--fail-on` triggers in a machine format, the result is still emitted and
the process exits non-zero (no error envelope is written over the payload).

## Notes

- `--type` (`all` default): `security` / `performance` select endpoints (linked) or filter categories (local).
- `--level` (`warn` default) sets the minimum issue level to display.
- `--fail-on` (`none` default) sets the level that forces a non-zero exit.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution used for the connection and
  the linked-project cache (flag > `SUPABASE_PROJECT_ID` >
  `.temp/project-ref`). It never implies `--linked`: passing it with a
  resolved `--local`/`--db-url` target is a hard error rather than a silently
  discarded flag (deliberately stricter than `SUPABASE_PROJECT_ID`, which Go's
  equivalent env var simply leaves unused on a non-linked target).
- Not-logged-in suggestion: `Run supabase login first.`
- Telemetry: only the standard `cli_command_executed` event (no custom events).

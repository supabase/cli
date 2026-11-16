# `supabase db advisors`

Target: selectable, no consent — see [Command target](../../../../docs/command-target.md)

Checks a database for security and performance issues. Two backends: the local
stack and `--remote=<url>` query the database directly; a project fetches from the
Management API.

## Files Read

| Path                                   | Format     | When                                                                                                                                                       |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | local / `--remote=<url>` — to resolve the DB connection and `[api].enabled` / `[api].schemas`                                                              |
| `~/.supabase/access-token`             | plain text | a remote project or branch only, when `SUPABASE_ACCESS_TOKEN` unset (keyring → file)                                                                       |
| `<workdir>/supabase/.temp/project-ref` | plain text | bare `--remote` — to resolve the project ref, skipped when `SUPABASE_PROJECT_ID` is set; with no selector — only to name the project in the `Target:` hint |
| `PGSSL*` PEM, `pg_service.conf`        | PEM, libpq | `--remote=<url>` or local on the experimental stack (shell env only), when set; client cert and key never for the local stack database; see `db push`      |

## Files Written

| Path                                           | Format | When                                                            |
| ---------------------------------------------- | ------ | --------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (PostHog state flush)                                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | a remote project or branch only, via `LinkedProjectCache.cache` |

The local lint query runs inside a transaction that is **always rolled back**.

## API Routes (remote project or branch only)

| Method | Path                                      | Auth   | Request | Response (used fields)                                                                                                                                                                          |
| ------ | ----------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/projects/{ref}/advisors/security`    | Bearer | —       | `{ lints: Lint[] }`                                                                                                                                                                             |
| GET    | `/v1/projects/{ref}/advisors/performance` | Bearer | —       | `{ lints: Lint[] }`                                                                                                                                                                             |
| GET    | `/v1/projects/{parent}/branches`          | Bearer | —       | `[{id, name, project_ref}]` — only for `--remote=<branch>`, and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| GET    | `/v1/branches/{id}`                       | Bearer | —       | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                |

Issued through the typed client; the generated schema keeps advisor
`name` / `metadata.type` open, so values the API can add do not fail decoding.
`--type` selects which endpoints run:
`security` → security only, `performance` → performance only, `all` → both.

## Database (local / `--remote=<url>`)

One connection. Within one transaction: `BEGIN` → `set_config('pgrst.db_schemas', <exposed schemas or ''>, true)` → `set local search_path = ''`
(setup half of `templates/lints.sql`) → the multi-CTE lints query → `ROLLBACK`.
`--type` filters the resulting rows by category (`SECURITY` / `PERFORMANCE`).

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `SUPABASE_API_SCHEMAS`  | overrides `[api].schemas` for local / `--remote=<url>`                                                                    | no                                        |
| `SUPABASE_API_ENABLED`  | overrides `[api].enabled` for local / `--remote=<url>`; when false, no schemas are exposed to the lints                   | no                                        |
| `SUPABASE_ACCESS_TOKEN` | auth token for a remote project or branch                                                                                 | no (keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | linked project ref override, and the parent that `--remote=<branch>` is resolved against (superseded by `--remote=<ref>`) | no                                        |
| `SUPABASE_PROFILE`      | API profile (built-in name or YAML path)                                                                                  | no                                        |
| `PGHOST` / `PGPORT` / … | connection overrides (local / `--remote=<url>`)                                                                           | no                                        |
| `PG*` libpq             | `--remote=<url>` TLS, timeout, service, and local on the experimental stack (shell env only); see `db push`               | no                                        |

The API base URL is derived from `SUPABASE_PROFILE`; `SUPABASE_API_URL` is **not**
honored (see `command-settings.layer.unit.test.ts`).

## Exit Codes

| Code | Condition                                                                   |
| ---- | --------------------------------------------------------------------------- |
| `0`  | success — no issues at or above `--fail-on` (empty result is still `0`)     |
| `1`  | a remote project or branch with no access token (suggests `supabase login`) |
| `1`  | connection / `BEGIN` / setup / query failure (local, `--remote=<url>`)      |
| `1`  | advisors API non-200 (remote project or branch)                             |
| `1`  | a lint's level is at or above `--fail-on`                                   |

## Output

### `--output-format text`

Diagnostics on **stderr**: alias deprecation warnings, the `Target:` line, and
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

- `--type` (`all` default): `security` / `performance` select endpoints (remote) or filter categories (local, `--remote=<url>`).
- `--level` (`warn` default) sets the minimum issue level to display.
- `--fail-on` (`none` default) sets the level that forces a non-zero exit.
- Not-logged-in suggestion: `Run supabase login first.`
- Telemetry: only the standard `cli_command_executed` event (no custom events).
- Exposure reflects config on disk, which may differ from a stack started with older config.
- `--db-url` uses the local `[api]` exposure even when the URL points at a remote database, because a raw URL does not identify a project whose Data API settings could be read; align `[api]` (or `SUPABASE_API_SCHEMAS` / `SUPABASE_API_ENABLED`) with the target, or use `--linked`.
- The exposure value reverts at rollback, but the setting stays defined and later reads `''` on that backend.
- `--linked` exposure is set by the platform.

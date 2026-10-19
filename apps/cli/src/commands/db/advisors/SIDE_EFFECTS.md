# `supabase db advisors`

Checks a database for security and performance issues. Two backends: the local
stack and `--remote=<url>` query the database directly; a project fetches from the
Management API.

With no selector the command checks the local stack, and in a linked checkout the `Target:`
line adds `default; pass --remote for <project>`. `--remote` selects the linked project,
`--remote=<ref>` another project, `--remote=<branch>` a branch of the linked project (by name
or UUID) and `--remote=<url>` a Postgres connection string
(see [ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md)).
It only reads, so it never asks for confirmation, on any target.

## Files Read

| Path                                   | Format     | When                                                                                                                                                       |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | local / `--remote=<url>` — to resolve the DB connection config                                                                                             |
| `~/.supabase/access-token`             | plain text | a remote project or branch only, when `SUPABASE_ACCESS_TOKEN` unset (keyring → file)                                                                       |
| `<workdir>/supabase/.temp/project-ref` | plain text | bare `--remote` — to resolve the project ref, skipped when `SUPABASE_PROJECT_ID` is set; with no selector — only to name the project in the `Target:` hint |

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

Issued through the typed client; the generated schema keeps advisor
`name` / `metadata.type` open, so values the API can add do not fail decoding.
`--type` selects which endpoints run:
`security` → security only, `performance` → performance only, `all` → both.

## Database (local / `--remote=<url>`)

One connection. Within one transaction: `BEGIN` → `set local search_path = ''`
(setup half of `templates/lints.sql`) → the multi-CTE lints query → `ROLLBACK`.
`--type` filters the resulting rows by category (`SECURITY` / `PERFORMANCE`).

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for a remote project or branch                                                                                 | no (keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | linked project ref override, and the parent that `--remote=<branch>` is resolved against (superseded by `--remote=<ref>`) | no                                        |
| `SUPABASE_PROFILE`      | API profile (built-in name or YAML path)                                                                                  | no                                        |
| `PGHOST` / `PGPORT` / … | connection overrides (local / `--remote=<url>`)                                                                           | no                                        |

The API base URL is derived from `SUPABASE_PROFILE`; `SUPABASE_API_URL` is **not**
honored (see `command-settings.layer.unit.test.ts`).

## Exit Codes

| Code | Condition                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | success — no issues at or above `--fail-on` (empty result is still `0`)                            |
| `1`  | more than one of `--remote` / `--linked` / `--db-url` / `--local` (`TargetSelectorConflictError`)  |
| `1`  | a remote project or branch with no access token (suggests `supabase login`)                        |
| `1`  | `--remote=<branch>` naming no branch of the parent project                                         |
| `1`  | connection / `BEGIN` / setup / query failure (local, `--remote=<url>`)                             |
| `1`  | advisors API non-200 (remote project or branch)                                                    |
| `1`  | a lint's level is at or above `--fail-on`                                                          |
| `1`  | `--project-ref` with `--local`, `--db-url` or `--remote=<value>` (`TargetProjectRefConflictError`) |

## Output

### `--output-format text`

Diagnostics on **stderr**: the `Target: …` line (remote project `Target: <name> (<ref>)`, branch
`Target: project <parent> · branch <name> (<ref>)`, `Target: local stack (<host>:<port>)` with
` · default; pass --remote for <project>` appended in a linked checkout when no selector was given,
or `Target: custom Postgres (<host>:<port>)`), alias deprecation warnings, and
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
- **Target selection.** `--remote` is read as the linked project (bare), a project ref (20
  lowercase letters), a Postgres URL, or else a branch of the linked project by name or UUID;
  `--remote=false` and `--remote=` fail with `Leave out --remote to target the local database.` A bare
  `--remote` followed by a word that is a branch of the linked project fails with a
  `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- **Deprecated aliases.** `--linked`, `--project-ref=<ref>`, `--db-url=<url>` and `--local` still
  work and print a deprecation warning on stderr naming the `--remote` replacement (`--local`
  warns that local is the default). They are mutually exclusive with each other and with
  `--remote`; a `false` switch counts as absent. `--project-ref` with `--local`, `--db-url` or
  `--remote=<value>` is a hard error.
- Not-logged-in suggestion: `Run supabase login first.`
- Telemetry: only the standard `cli_command_executed` event (no custom events).

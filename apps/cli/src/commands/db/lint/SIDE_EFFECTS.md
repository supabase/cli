# `supabase db lint`

Checks a database for PL/pgSQL typing errors via the `plpgsql_check` extension.

With no selector the command lints the local stack, and in a linked checkout the `Target:` line
adds `default; pass --remote for <project>`. `--remote` selects the linked project,
`--remote=<ref>` another project, `--remote=<branch>` a branch of the linked project (by name or
UUID) and `--remote=<url>` a custom database (see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md)).
It only reads, so it never asks for confirmation, on any target.

## Files Read

| Path                                   | Format     | When                                                                                                                                                           |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | always — to resolve the local / remote DB connection config                                                                                                    |
| `~/.supabase/access-token`             | plain text | a remote project or branch only, when `SUPABASE_ACCESS_TOKEN` unset (keyring → file)                                                                           |
| `<workdir>/supabase/.temp/project-ref` | plain text | bare `--remote` only, to resolve the project ref — skipped when `SUPABASE_PROJECT_ID` is set; with no selector, only to name the project in the `Target:` hint |

## Files Written

| Path                                           | Format | When                                                            |
| ---------------------------------------------- | ------ | --------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | a remote project or branch only, via `LinkedProjectCache.cache` |
| `~/.supabase/telemetry.json`                   | JSON   | always (PostHog state flush)                                    |

No user data is written: the lint runs inside a transaction that is **always
rolled back** (`BEGIN` … `ROLLBACK`) — including
`CREATE EXTENSION plpgsql_check`, which is issued on the same connection inside
the open transaction and so is rolled back too. `db lint` DOES write the
linked-project cache when it targets a remote project or branch; the local and
`--remote=<url>` paths never populate a project ref, so no cache write occurs there.

## API Routes

None called directly. A remote project or branch resolves the project's direct-DB connection
through the shared db-config resolver (which may call the Management API to
resolve credentials); the lint itself issues no advisor/API requests.

`--remote=<branch>`, and a bare `--remote` followed by a word that could name a branch, also call
`GET /v1/projects/{parent}/branches` (Bearer) to find the branch's project; `{parent}` is
`SUPABASE_PROJECT_ID`, else the linked project.

## Database

One connection (local / `--remote=<url>` / remote-direct). Within one transaction:

1. `BEGIN`
2. (when `--schema` is omitted) `ListUserSchemas` — `... not nspname like any($1)` with the managed-schemas array bound as `$1`
3. `CREATE EXTENSION IF NOT EXISTS plpgsql_check`
4. per schema: `SELECT p.proname, plpgsql_check_function(p.oid, format:='json') …` (`templates/check.sql`)
5. `ROLLBACK` (always — lint has no committed effects)

Requires `plpgsql_check` to be installable; a bare vanilla `--remote=<url>` without
the extension fails at step 3. Stack catalog Postgres (native artifact and the
digest-pinned image) ships the extension, so a local lint on native and
container stacks can enable it. Compose uses the Compose Postgres image.

## Environment Variables

| Variable                | Purpose                                                                                                                  | Required?                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for a remote project or branch                                                                                | no (keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | linked project ref override and the parent that `--remote=<branch>` is resolved against (superseded by `--remote=<ref>`) | no                                        |
| `SUPABASE_DB_PASSWORD`  | remote direct-DB password                                                                                                | no                                        |
| `SUPABASE_PROFILE`      | API profile (built-in name or YAML path)                                                                                 | no                                        |
| `PGHOST` / `PGPORT` / … | connection overrides                                                                                                     | no                                        |

## Exit Codes

| Code | Condition                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | success — no issues at or above `--fail-on` (an empty result is still `0`)                         |
| `1`  | more than one of `--remote` / `--linked` / `--db-url` / `--local` (`TargetSelectorConflictError`)  |
| `1`  | connection / `BEGIN` / list-schemas / enable-extension / query failure                             |
| `1`  | `--remote=<branch>` naming no branch of the parent project                                         |
| `1`  | malformed `plpgsql_check` JSON                                                                     |
| `1`  | an issue's level is at or above `--fail-on`                                                        |
| `1`  | `--project-ref` with `--local`, `--db-url` or `--remote=<value>` (`TargetProjectRefConflictError`) |

## Output

### `--output-format text`

Diagnostics on **stderr**: alias deprecation warnings, the `Target: …` line (remote project
`Target: <name> (<ref>)`, branch `Target: project <parent> · branch <name> (<ref>)`,
`Target: local stack (<host>:<port>)` with ` · default; pass --remote for <project>` appended in a
linked checkout when no selector was given, or `Target: custom Postgres (<host>:<port>)`),
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
- **Target selection.** `--remote` is read as the linked project (bare), a project ref (20
  lowercase letters), a Postgres URL, or else a branch of the linked project by name or UUID;
  `--remote=false` and `--remote=` fail with `Leave out --remote to target the local database.` A
  bare `--remote` followed by a word that is a branch of the linked project fails with a
  `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- **Deprecated aliases.** `--linked`, `--project-ref=<ref>`, `--db-url=<url>` and `--local` still
  work and print a deprecation warning on stderr naming the `--remote` replacement (`--local`
  warns that local is the default). They are mutually exclusive with each other and with
  `--remote`; a `false` switch counts as absent. `--project-ref` with `--local`, `--db-url` or
  `--remote=<value>` is a hard error.
- Telemetry: only the standard `cli_command_executed` event (no custom events).

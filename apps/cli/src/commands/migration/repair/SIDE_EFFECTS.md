# `supabase migration repair`

## Files Read

| Path                                   | Format     | When                                                                                                       |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | always, for the workspace `target` (flag > `SUPABASE_TARGET` > project `.env*` > config)                   |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is linked                                                |
| `<workdir>/supabase/.temp/project-ref` | plain text | linked target, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set         |
| `<workdir>/supabase/migrations/`       | directory  | `--status applied` (the matching file per version) and repair-all (every local version), before connecting |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                                                                 | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for a linked target                                                          | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the linked database connection (`--password`/`-p` takes precedence)        | no                                                      |
| `SUPABASE_TARGET`       | workspace target (`local` or `remote`) when no selector flag is given                   | no                                                      |
| `SUPABASE_YES`          | confirms a hosted repair when exported in the shell (the project `.env` does not count) | no                                                      |

## Exit Codes

| Code | Condition                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                          |
| `1`  | database connection failure                                                                      |
| `1`  | `--password` with a target other than linked                                                     |
| `1`  | invalid or missing `--status` flag                                                               |
| `1`  | conflicting target selectors (see Notes)                                                         |
| `1`  | a version's local migration file is missing (`--status applied`)                                 |
| `1`  | hosted target without `--yes` in a run that cannot prompt (`HostedMutationConsentRequiredError`) |
| `1`  | hosted confirmation declined (`context canceled`)                                                |

## Output

### `--output-format text`

Prints `Target: …` to stderr first. When repairing specific versions, prints `Repaired migration history: [<versions>]
=> <status>` to stderr, then `Finished supabase migration repair.` to stdout and
the suggestion `Run supabase migration list to show the updated migration history.`
to stderr. The DB work is the history-table provisioning (its own transaction,
skipped entirely when a read-only probe finds the ledger already provisioned, so a
provisioned remote runs no provisioning DDL — supabase/cli#6393) followed by one
repair transaction: (for repair-all) `TRUNCATE`, plus `applied` → per-version
`UPSERT` from the local file, `reverted` → `DELETE ... WHERE version = ANY($1)`.

> **Atomicity note:** the TRUNCATE/UPSERT/DELETE statements run in an explicit
> `BEGIN`/`COMMIT` with `ROLLBACK` on error, so a partial failure (e.g. TRUNCATE
> succeeds but a later UPSERT fails) leaves the table unchanged. This handler keeps
> that transaction instead of using the migration apply path's batch primitive.

### `--output-format json`

Emits `output.success("Migration history repaired", { versions, status, repairAll })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- A hosted target (the linked project or a non-local `--db-url`) asks once, after the versions and
  local files are resolved and before the history table is created or changed. The plan lists
  each version (`Mark <n> migrations as <status>`), or for repair-all the table replacement or
  clearing. The default is **NO**. Only `--yes` or an exported `SUPABASE_YES` approves a run that
  cannot prompt; a piped answer and a `SUPABASE_YES` in the project `.env` do not. Declining exits
  1 (`context canceled`) and changes nothing.
- A local target never prompts, including repair-all.

## Notes

- **Target.** With no selector the command follows the workspace target: the local database, or the
  linked project when `target = "remote"` is set in `supabase/config.toml` (or `SUPABASE_TARGET=remote`
  is exported). `--local`, `--linked` and `--db-url` are mutually exclusive and `--linked=false`
  selects nothing. `--project-ref` implies `--linked` and is rejected with `--local` or `--db-url`;
  an empty `--db-url` or `--project-ref` is rejected. The resolved target is announced on stderr
  (`Target: …`) in every output format and, in JSON results, as a `target` object.
- `--status` flag is required and accepts `applied` or `reverted`.
- Accepts zero or more migration version arguments; each must be numeric
  (`failed to parse <v>: invalid version number` otherwise). Zero versions enables
  repair-all.
- In `applied` mode, reads the matching `supabase/migrations/<version>_*.sql` file
  for the name + statements before connecting; a missing file exits non-zero without touching the
  database.
- **`--password`** is rejected unless the target is the linked project: with `--db-url` the error is
  `--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres`,
  and with a local target `--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.`
  (exit 1). For the linked project the password resolves as flag > shell `SUPABASE_DB_PASSWORD` > project
  `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`), and a
  temporary login role is minted instead (ADR 0032).

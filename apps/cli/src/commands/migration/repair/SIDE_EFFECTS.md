# `supabase migration repair`

## Files Read

| Path                                   | Format     | When                                                                                                      |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked`                                                         |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked` (default), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                                                          | Required?                                               |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode                                                   | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the linked database connection (`--password`/`-p` takes precedence) | no                                                      |

## Exit Codes

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | database connection failure                                              |
| `1`  | `--password` with `--db-url` or `--local`                                |
| `1`  | invalid or missing `--status` flag                                       |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

When repairing specific versions, prints `Repaired migration history: [<versions>]
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

- With no version arguments (repair-all), prompts `Do you want to repair the entire
migration history table to match local migration files?` (default **NO**).
  Declining exits non-zero (`context canceled`). `--yes` auto-confirms; a
  non-interactive / machine-output run takes the default (NO → cancel).

## Notes

- `--status` flag is required and accepts `applied` or `reverted`.
- Accepts zero or more migration version arguments; each must be numeric
  (`failed to parse <v>: invalid version number` otherwise). Zero versions enables
  repair-all.
- In `applied` mode, reads the matching `supabase/migrations/<version>_*.sql` file
  for the name + statements; a missing file exits non-zero.
- `--linked` (default true), `--local`, and `--db-url` are mutually exclusive.
- **`--password`** is rejected with `--db-url` (and with `--local`): `if any flags in the group
[<target> password] are set none of the others can be; [<target> password] were all set`,
  exit 1. For `--linked` the password resolves as flag > shell `SUPABASE_DB_PASSWORD` > project
  `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr `WARN: ignoring SUPABASE_DB_PASSWORD because this directory is linked to project <linked>, not <target>. Pass --password to use a database password for <target>.`), and a
  temporary login role is minted instead (ADR 0031).
- **`--project-ref`** overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which is simply unused on
  a non-linked target).

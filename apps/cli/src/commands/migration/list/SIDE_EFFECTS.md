# `supabase migration list`

## Files Read

| Path                                   | Format     | When                                                                                               |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | always, for the workspace `target` (flag > `SUPABASE_TARGET` > project `.env*` > config)           |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is linked                                        |
| `<workdir>/supabase/.temp/project-ref` | plain text | linked target, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `<workdir>/supabase/migrations/`       | directory  | always, to list local migration files                                                              |

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
| `SUPABASE_ACCESS_TOKEN` | auth token for a linked target                                                   | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the linked database connection (`--password`/`-p` takes precedence) | no                                                      |
| `SUPABASE_TARGET`       | workspace target (`local` or `remote`) when no selector flag is given            | no                                                      |

## Exit Codes

| Code | Condition                                    |
| ---- | -------------------------------------------- |
| `0`  | success                                      |
| `1`  | database connection failure                  |
| `1`  | `--password` with a target other than linked |
| `1`  | failed to open migrations directory          |
| `1`  | conflicting target selectors (see Notes)     |

## Output

### `--output-format text`

Prints `Target: …` to stderr first, then an ASCII table `|Local|Remote|Time (UTC)|` to stdout (cells are backtick-wrapped inline code). The database column is headed `Remote` for a linked or `--db-url` target and `Local DB` for the local database. Queries `SELECT version FROM
supabase_migrations.schema_migrations ORDER BY version` (a missing table → empty
database column).

### `--output-format json`

Emits `output.success("Migrations listed", { migrations: [{ local, remote, time }] })`.
`local`/`remote` are empty strings when a version exists only on the other side.

### `--output-format stream-json`

Same structured `migrations` result delivered as an NDJSON `result` event.

## Notes

- **Target.** With no selector the command follows the workspace target: the local database, or the
  linked project when `target = "remote"` is set in `supabase/config.toml` (or `SUPABASE_TARGET=remote`
  is exported). `--local`, `--linked` and `--db-url` are mutually exclusive and `--linked=false`
  selects nothing. `--project-ref` implies `--linked` and is rejected with `--local` or `--db-url`;
  an empty `--db-url` or `--project-ref` is rejected. The resolved target is announced on stderr
  (`Target: …`) in every output format and, in JSON results, as a `target` object.
- Listing is a read: it never asks for confirmation, on any target.
- **`--password`** is rejected unless the target is the linked project: with `--db-url` the error is
  `--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres`,
  and with a local target `--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.`
  (exit 1). For the linked project the password resolves as flag > shell `SUPABASE_DB_PASSWORD` > project
  `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`), and a
  temporary login role is minted instead (ADR 0032).

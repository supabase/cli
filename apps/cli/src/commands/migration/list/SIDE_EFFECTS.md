# `supabase migration list`

## Files Read

| Path                                   | Format     | When                                                                                                      |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked`                                                         |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked` (default), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `<workdir>/supabase/migrations/`       | directory  | always, to list local migration files                                                                     |

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
| `1`  | failed to open migrations directory                                      |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

Prints a Glamour ASCII table `|Local|Remote|Time (UTC)|` to stdout (`AsciiStyle`
rendering; cells are backtick-wrapped inline code). Queries `SELECT version FROM
supabase_migrations.schema_migrations ORDER BY version` (a missing table → empty
Remote column).

### `--output-format json`

Emits `output.success("Migrations listed", { migrations: [{ local, remote, time }] })`.
`local`/`remote` are empty strings when a version exists only on the other side.

### `--output-format stream-json`

Same structured `migrations` result delivered as an NDJSON `result` event.

## Notes

- `--linked` (default true) lists migrations from the linked project via direct DB connection.
- `--local` lists migrations applied to the local database.
- `--db-url` targets a specific database URL directly.
- **`--password`** is rejected with `--db-url` (`--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres`) and with `--local` (`--password can't be used with --local. The local database uses [db].password from supabase/config.toml.`),
  exit 1. For `--linked` the password resolves as flag > shell `SUPABASE_DB_PASSWORD` > project
  `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`), and a
  temporary login role is minted instead (ADR 0031).
- `--db-url`, `--linked`, and `--local` are mutually exclusive.
- **`--project-ref`** overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which is simply unused on
  a non-linked target).

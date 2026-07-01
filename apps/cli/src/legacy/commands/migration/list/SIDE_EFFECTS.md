# `supabase migration list`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<workdir>/supabase/migrations/` | directory  | always, to list local migration files             |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                 | Required?                                               |
| ----------------------- | --------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode          | no (falls back to keyring → `~/.supabase/access-token`) |
| `DB_PASSWORD`           | password for direct database connection | no                                                      |

## Exit Codes

| Code | Condition                           |
| ---- | ----------------------------------- |
| `0`  | success                             |
| `1`  | database connection failure         |
| `1`  | failed to open migrations directory |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Glamour ASCII table `|Local|Remote|Time (UTC)|` to stdout (byte-matching
Go's `glamour.RenderTable` with `AsciiStyle`; cells are backtick-wrapped inline
code). Queries `SELECT version FROM supabase_migrations.schema_migrations ORDER BY
version` (a missing table → empty Remote column).

### `--output-format json`

Emits `output.success("Migrations listed", { migrations: [{ local, remote, time }] })`.
`local`/`remote` are empty strings when a version exists only on the other side.

### `--output-format stream-json`

Same structured `migrations` result delivered as an NDJSON `result` event.

## Notes

- `--linked` (default true) lists migrations from the linked project via direct DB connection.
- `--local` lists migrations applied to the local database.
- `--db-url` targets a specific database URL directly.
- `--password` / `-p` sets the DB password (also reads `DB_PASSWORD` env var).
- `--db-url`, `--linked`, and `--local` are mutually exclusive.

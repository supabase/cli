# `supabase migration up`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `<workdir>/supabase/migrations/` | directory  | always, to read pending migration files           |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                        | Required?                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode | no (falls back to keyring → `~/.supabase/access-token`) |

## Exit Codes

| Code | Condition                     |
| ---- | ----------------------------- |
| `0`  | success                       |
| `1`  | database connection failure   |
| `1`  | migration SQL execution error |

## Output

### `--output-format text` (Go CLI compatible)

Prints "Local database is up to date." on success (no pending migrations) or the applied migration filenames.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--local` (default true), `--linked`, and `--db-url` are mutually exclusive.
- `--include-all` applies all migrations not found on the remote history table.

# `supabase migration fetch`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path                                                 | Format   | When                                            |
| ---------------------------------------------------- | -------- | ----------------------------------------------- |
| `<workdir>/supabase/migrations/<version>_<name>.sql` | SQL text | always — writes fetched migration files locally |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                        | Required?                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode | no (falls back to keyring → `~/.supabase/access-token`) |

## Exit Codes

| Code | Condition                       |
| ---- | ------------------------------- |
| `0`  | success                         |
| `1`  | database connection failure     |
| `1`  | failed to write migration files |

## Output

### `--output-format text` (Go CLI compatible)

Prints the names of migration files fetched from the history table.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--linked` (default true), `--local`, and `--db-url` are mutually exclusive.
- Fetches migration file contents from the `supabase_migrations.schema_migrations` history table.

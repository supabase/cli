# `supabase migration squash`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `<workdir>/supabase/migrations/` | directory  | always, to read migration files                   |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path                                   | Format   | When                              |
| -------------------------------------- | -------- | --------------------------------- |
| `<workdir>/supabase/migrations/` files | SQL text | always — squashes migration files |

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
| `1`  | failed to read migrations directory |

## Output

### `--output-format text` (Go CLI compatible)

Prints "Finished `supabase migration squash`." on success.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--version` squashes up to the specified migration version.
- `--local` (default true), `--linked`, and `--db-url` are mutually exclusive.
- `--password` / `-p` sets the DB password.

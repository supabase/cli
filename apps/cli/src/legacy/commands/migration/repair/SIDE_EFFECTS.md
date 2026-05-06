# `supabase migration repair`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

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

| Code | Condition                          |
| ---- | ---------------------------------- |
| `0`  | success                            |
| `1`  | database connection failure        |
| `1`  | invalid or missing `--status` flag |

## Output

### `--output-format text` (Go CLI compatible)

Prints "Finished `supabase migration repair`." on success.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--status` flag is required and accepts `applied` or `reverted`.
- Accepts one or more migration version arguments.
- `--linked` (default true), `--local`, and `--db-url` are mutually exclusive.
- `--password` / `-p` sets the DB password.

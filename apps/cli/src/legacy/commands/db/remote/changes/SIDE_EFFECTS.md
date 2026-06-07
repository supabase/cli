# `supabase db remote changes`

## Files Read

| Path                       | Format     | When                               |
| -------------------------- | ---------- | ---------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset |

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
| `SUPABASE_ACCESS_TOKEN` | auth token                              | no (falls back to keyring → `~/.supabase/access-token`) |
| `DB_PASSWORD`           | password for direct database connection | no                                                      |

## Exit Codes

| Code | Condition                   |
| ---- | --------------------------- |
| `0`  | success                     |
| `1`  | database connection failure |

## Output

### `--output-format text` (Go CLI compatible)

Prints the schema diff (changes on the remote database since the last migration) to stdout.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Deprecated in the Go CLI: use `db diff --use-migra --linked` instead.
- `--schema` / `-s` restricts the diff to specific schemas.
- `--db-url` and `--linked` (default true) are mutually exclusive.

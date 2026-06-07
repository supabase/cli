# `supabase db remote commit`

## Files Read

| Path                       | Format     | When                               |
| -------------------------- | ---------- | ---------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset |

## Files Written

| Path                                                          | Format | When   |
| ------------------------------------------------------------- | ------ | ------ |
| `<workdir>/supabase/migrations/<timestamp>_remote_commit.sql` | SQL    | always |

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
| `1`  | schema pull error           |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Finished supabase db pull.` on success.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Deprecated in the Go CLI: use `db pull` instead.
- `--schema` / `-s` restricts the commit to specific schemas.
- `--db-url` and `--linked` (default true) are mutually exclusive.

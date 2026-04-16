# `supabase db pull`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path                                                   | Format | When   |
| ------------------------------------------------------ | ------ | ------ |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql` | SQL    | always |

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

- Optional positional argument sets the migration name (defaults to `remote_schema`).
- `--schema` / `-s` restricts pull to specific schemas.
- `--db-url`, `--linked` (default true), and `--local` are mutually exclusive.
- `--use-pg-delta` activates declarative pull output through pg-delta.

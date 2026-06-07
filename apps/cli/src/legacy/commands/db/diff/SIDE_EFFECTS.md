# `supabase db diff`

## Files Read

| Path                             | Format     | When                                                            |
| -------------------------------- | ---------- | --------------------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--db-url` |
| `<workdir>/supabase/config.toml` | TOML       | always, to resolve local DB config                              |

## Files Written

| Path                            | Format | When                      |
| ------------------------------- | ------ | ------------------------- |
| `<path>` (from `--file` / `-f`) | SQL    | when `--file` flag is set |

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
| `1`  | schema diff error           |

## Output

### `--output-format text` (Go CLI compatible)

Prints the schema diff in SQL migration format to stdout, or writes it to the file specified by `--file`.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--use-migra` (default true), `--use-pgadmin`, `--use-pg-schema`, `--use-pg-delta` are mutually exclusive differ strategies.
- `--from` and `--to` enable explicit diff mode; both must be set together.
- `--db-url`, `--linked`, and `--local` are mutually exclusive.
- `--schema` / `-s` restricts diff to specific schemas.

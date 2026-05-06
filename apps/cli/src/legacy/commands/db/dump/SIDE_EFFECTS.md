# `supabase db dump`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

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
| `1`  | pg_dump error               |

## Output

### `--output-format text` (Go CLI compatible)

Prints the pg_dump SQL output to stdout (or to the file specified by `--file`). Prints a confirmation message to stderr when `--file` is used.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--data-only` and `--role-only` are mutually exclusive.
- `--use-copy` and `--exclude` require `--data-only`.
- `--keep-comments` and `--data-only` are mutually exclusive.
- `--db-url`, `--linked` (default true), and `--local` are mutually exclusive.
- `--dry-run` prints the pg_dump command that would be executed without running it.

# `supabase db push`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<workdir>/supabase/migrations/` | directory  | always, to list migration files to push           |
| `<workdir>/supabase/roles.sql`   | SQL        | when `--include-roles` is set                     |
| seed files from config           | SQL        | when `--include-seed` is set                      |

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

| Code | Condition                   |
| ---- | --------------------------- |
| `0`  | success                     |
| `1`  | database connection failure |
| `1`  | migration apply error       |

## Output

### `--output-format text` (Go CLI compatible)

Prints applied migration versions to stderr. With `--dry-run`, prints the migrations that would be applied.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--dry-run` prints the migrations that would be applied without applying them.
- `--include-all` includes all migrations not found in remote history table.
- `--include-roles` includes custom roles from the roles file.
- `--include-seed` includes seed data from config.
- `--db-url`, `--linked` (default true), and `--local` are mutually exclusive.

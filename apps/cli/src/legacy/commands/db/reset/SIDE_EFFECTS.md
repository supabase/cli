# `supabase db reset`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<workdir>/supabase/migrations/` | directory  | always, to load migration files                   |
| seed files from config           | SQL        | unless `--no-seed` is set                         |

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

Prints progress to stderr as migrations are applied.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--no-seed` skips running the seed script after reset.
- `--version` resets up to the specified migration version.
- `--last` resets up to the last n migration versions; mutually exclusive with `--version`.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.

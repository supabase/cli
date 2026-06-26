# `supabase db reset`

## Files Read

| Path                                    | Format     | When                                              |
| --------------------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token`              | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<workdir>/supabase/migrations/`        | directory  | always, to load migration files                   |
| seed files from config or `--sql-paths` | SQL        | unless `--no-seed` is set                         |

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
- `--sql-paths` overrides `[db.seed].sql_paths` for one reset; repeat it to seed multiple files or glob patterns.
- `--sql-paths` force-enables seeding for that reset even when `[db.seed].enabled = false`.
- With `--linked` or `--db-url`, `--sql-paths` seeds the selected remote database after migrations.
- `--version` resets up to the specified migration version.
- `--last` resets up to the last n migration versions; mutually exclusive with `--version`.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.

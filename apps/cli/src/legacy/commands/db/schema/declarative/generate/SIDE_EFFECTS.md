# `supabase db schema declarative generate`

## Files Read

| Path                                    | Format     | When                                              |
| --------------------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token`              | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<workdir>/supabase/config.toml`        | TOML       | always, to load project config                    |
| `<workdir>/.supabase/.temp/project-ref` | plain text | when `--linked`                                   |

## Files Written

| Path                                                       | Format | When                                 |
| ---------------------------------------------------------- | ------ | ------------------------------------ |
| `<workdir>/supabase/schema/<schema>.sql` (declarative dir) | SQL    | always (overwrites if `--overwrite`) |

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

| Code | Condition                      |
| ---- | ------------------------------ |
| `0`  | success                        |
| `1`  | database connection failure    |
| `1`  | schema generation error        |
| `1`  | pg-delta not enabled in config |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Finished supabase db schema declarative generate.` on success.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in `config.toml`.
- `--db-url`, `--linked`, and `--local` are mutually exclusive.
- In interactive mode (no explicit target), prompts user to choose the source database.
- `--reset` resets the local database before generating (local data will be lost).
- `--overwrite` skips the confirmation prompt when declarative schema files already exist.
- `--no-cache` forces a fresh shadow database setup, bypassing catalog snapshots.

# `supabase db lint`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `<workdir>/supabase/config.toml` | TOML       | always, to resolve local DB config                |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                        | Required?                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode | no (falls back to keyring → `~/.supabase/access-token`) |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success (no issues above `--fail-on`) |
| `1`  | database connection failure           |
| `1`  | issues found above `--fail-on` level  |

## Output

### `--output-format text` (Go CLI compatible)

Prints lint warnings and errors to stdout as a table.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--level` sets the minimum error level to emit (default: `warning`).
- `--fail-on` sets the error level to exit with non-zero status (default: `none`).
- `--schema` / `-s` restricts linting to specific schemas.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.

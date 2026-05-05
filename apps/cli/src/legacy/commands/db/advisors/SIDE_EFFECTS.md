# `supabase db advisors`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

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

Prints security and performance advisor results as a table.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--type` selects the type of advisors: `all`, `security`, `performance`.
- `--level` sets the minimum issue level to display: `info`, `warn`, `error`.
- `--fail-on` sets the issue level to exit with non-zero status: `none`, `info`, `warn`, `error`.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.

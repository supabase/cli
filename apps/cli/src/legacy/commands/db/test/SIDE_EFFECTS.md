# `supabase db test`

## Files Read

| Path                       | Format     | When                                              |
| -------------------------- | ---------- | ------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |
| `[path] ...` (positional)  | SQL (TAP)  | test files specified as positional arguments      |

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
| `0`  | all tests pass              |
| `1`  | database connection failure |
| `1`  | one or more tests fail      |

## Output

### `--output-format text` (Go CLI compatible)

Prints pgTAP test output (TAP format) to stdout.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Accepts optional path arguments to specify test files; runs all tests if none given.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- This is a hidden command in the Go CLI (`db test`, not the top-level `test` command).

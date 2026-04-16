# `supabase db branch list`

## Files Read

| Path                             | Format | When                               |
| -------------------------------- | ------ | ---------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to resolve local DB config |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                  |
| ---- | -------------------------- |
| `0`  | success                    |
| `1`  | local database not running |

## Output

### `--output-format text` (Go CLI compatible)

Prints a list of local branches to stdout.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Deprecated in the Go CLI: use `branches list` instead.
- This is a local-only operation listing branches in `<workdir>/.branches/`.

# `supabase db branch delete`

## Files Read

| Path                             | Format | When                               |
| -------------------------------- | ------ | ---------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to resolve local DB config |

## Files Written

| Path                                             | Format    | When    |
| ------------------------------------------------ | --------- | ------- |
| `<workdir>/.branches/<branch-name>/` (directory) | directory | removed |

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
| `1`  | branch not found           |
| `1`  | local database not running |

## Output

### `--output-format text` (Go CLI compatible)

Prints a confirmation message to stdout on success.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Deprecated in the Go CLI: use `branches delete <branch-id>` instead.
- Requires exactly one positional argument: the branch name.

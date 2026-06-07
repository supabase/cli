# `supabase migration new`

## Files Read

| Path    | Format   | When                                        |
| ------- | -------- | ------------------------------------------- |
| `stdin` | SQL text | when piped stdin is detected (non-TTY mode) |

## Files Written

| Path                                                   | Format   | When                              |
| ------------------------------------------------------ | -------- | --------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql` | SQL text | always — creates a new empty file |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success — migration file created      |
| `1`  | failed to create migrations directory |
| `1`  | failed to write migration file        |

## Output

### `--output-format text` (Go CLI compatible)

Prints the path of the created migration file.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Requires exactly one positional argument: the migration name.
- The file timestamp uses the current UTC time in `YYYYMMDDHHMMSS` format.
- If stdin is piped, the content is streamed into the new migration file.

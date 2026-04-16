# `supabase functions new <Function name>`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path                                           | Format     | When                               |
| ---------------------------------------------- | ---------- | ---------------------------------- |
| `<workdir>/supabase/functions/<name>/index.ts` | TypeScript | always (creates function scaffold) |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                         |
| ---- | --------------------------------- |
| `0`  | success                           |
| `1`  | invalid function name             |
| `1`  | function directory already exists |

## Output

### `--output-format text` (Go CLI compatible)

Prints a success message with the path to the created function file.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Creates a new Edge Function scaffold locally.
- Requires exactly one argument: the function name.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

# `supabase test new <name>`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path                                  | Format | When                               |
| ------------------------------------- | ------ | ---------------------------------- |
| `<workdir>/supabase/tests/<name>.sql` | SQL    | always (creates new test scaffold) |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                |
| ---- | ------------------------ |
| `0`  | success                  |
| `1`  | invalid test name        |
| `1`  | test file already exists |

## Output

### `--output-format text` (Go CLI compatible)

Prints a success message with the path to the created test file.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Creates a new pgTAP test file scaffold.
- `--template` / `-t` selects the template framework (default: `pgtap`).
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

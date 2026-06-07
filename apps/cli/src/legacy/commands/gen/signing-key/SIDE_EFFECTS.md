# `supabase gen signing-key`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

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

| Code | Condition                       |
| ---- | ------------------------------- |
| `0`  | success — key printed to stdout |
| `1`  | invalid algorithm specified     |

## Output

### `--output-format text` (Go CLI compatible)

Prints the generated signing key in PEM or JWK format to stdout.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--algorithm` accepts `ES256` (default, recommended) or `RS256`.
- `--append` appends the new key to an existing keys file instead of overwriting.
- Generates a private JWT signing key for use in the CLI or for import in the dashboard.

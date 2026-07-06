# `supabase gen bearer-jwt`

## Files Read

| Path                             | Format | When                           |
| -------------------------------- | ------ | ------------------------------ |
| `<workdir>/supabase/config.toml` | TOML   | to read JWT secret for signing |

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

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success — JWT printed to stdout       |
| `1`  | missing required `--role` flag        |
| `1`  | failed to parse claims or JWT signing |

## Output

### `--output-format text` (Go CLI compatible)

Prints the generated Bearer JWT token to stdout.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- `--role` flag is required (e.g., `anon`, `authenticated`, `service_role`).
- `--sub` flag sets the user ID to impersonate (defaults to `anonymous`).
- `--exp` sets an explicit expiry timestamp (RFC3339 format).
- `--valid-for` sets the validity duration (default 30 minutes).
- `--payload` accepts a JSON string of custom claims.
- Takes no positional arguments.

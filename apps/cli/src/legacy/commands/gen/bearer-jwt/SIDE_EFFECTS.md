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

**Known divergence on a missing `--role`:** TS's own parser now rejects a
missing `--role` before invoking the Go binary (matching Go's
`MarkFlagRequired("role")`, `cmd/gen.go:175`), but a pre-existing bug in the
vendored `effect` CLI library (tracked as CLI-1901, affects every command
with a required flag or `Flag.choice`, not just this one) makes that
rejection noisier than Go's own: the full help doc is dumped to **stdout**
and the error line is printed twice (once from the library, once from this
repo's Go-parity error renderer). Go's own equivalent failure is a single
clean stderr line with nothing on stdout. Do not rely on stdout being
token-only when `--role` is omitted until CLI-1901 is resolved.

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

# `supabase functions serve`

## Files Read

| Path                                           | Format     | When                                                |
| ---------------------------------------------- | ---------- | --------------------------------------------------- |
| `<workdir>/supabase/functions/<slug>/index.ts` | TypeScript | always (loads function source for serving)          |
| `<workdir>/supabase/config.toml`               | TOML       | to resolve function config (verify_jwt, import_map) |
| `<env-file>`                                   | plain text | when `--env-file` is set                            |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                              | Required? |
| ----------------------- | ------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (for Deno KV remote mode) | no        |

## Exit Codes

| Code | Condition                         |
| ---- | --------------------------------- |
| `0`  | server stopped (SIGINT/SIGTERM)   |
| `1`  | Docker not running or unavailable |
| `1`  | function serve startup failure    |

## Output

### `--output-format text` (Go CLI compatible)

Prints startup information and live request logs as functions are invoked.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Serves all functions locally using Deno and the Supabase Edge Runtime (via Docker).
- `--no-verify-jwt` disables JWT verification for development.
- `--env-file` path to env file populated to Function environment.
- `--import-map` path to custom import map.
- `--inspect` / `--inspect-mode` activates Deno inspector for debugging.
- `--all` is a hidden flag (default true) retained for backward compatibility; it has no effect because the Go CLI always serves all functions.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

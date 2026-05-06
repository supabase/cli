# `supabase functions deploy [Function name]`

## Files Read

| Path                                           | Format     | When                                                       |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/supabase/functions/<slug>/index.ts` | TypeScript | function source to deploy                                  |
| `<workdir>/supabase/config.toml`               | TOML       | to resolve function config (verify_jwt, import_map, etc.)  |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method  | Path                                  | Auth         | Request body               | Response (used fields) |
| ------- | ------------------------------------- | ------------ | -------------------------- | ---------------------- |
| `POST`  | `/v1/projects/{ref}/functions`        | Bearer token | function metadata + bundle | `{id, slug, ...}`      |
| `PATCH` | `/v1/projects/{ref}/functions/{slug}` | Bearer token | function metadata + bundle | `{id, slug, ...}`      |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | build / bundle failure                |
| `1`  | network / connection failure          |

## Output

### `--output-format text` (Go CLI compatible)

Prints progress and success messages as functions are deployed.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- If no function name is provided, deploys all functions found in `supabase/functions/`.
- Requires a linked project (`--project-ref` or linked project config).
- Uses Docker by default to bundle functions; `--use-api` switches to server-side bundling.
- `--prune` deletes functions that exist in the Supabase project but not locally.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

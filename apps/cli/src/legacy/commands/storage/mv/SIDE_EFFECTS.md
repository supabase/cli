# `supabase storage mv <src> <dst>`

## Files Read

| Path                       | Format     | When                                                       |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                      | Auth         | Request body                            | Response (used fields) |
| ------ | ------------------------- | ------------ | --------------------------------------- | ---------------------- |
| `POST` | `/storage/v1/object/move` | Bearer token | `{bucketId, sourceKey, destinationKey}` | none                   |

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
| `1`  | source object not found               |
| `1`  | network / connection failure          |

## Output

### `--output-format text` (Go CLI compatible)

Prints a success message after objects are moved.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Moves objects within Supabase Storage (both src and dst must use `ss:///` scheme).
- `--recursive` / `-r` moves directories recursively.
- `--linked` (default) connects to linked project Storage API.
- `--local` connects to local database Storage API.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

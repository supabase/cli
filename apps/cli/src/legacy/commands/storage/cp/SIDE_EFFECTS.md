# `supabase storage cp <src> <dst>`

## Files Read

| Path                       | Format     | When                                                       |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<src>`                    | binary     | when src is a local file path                              |

## Files Written

| Path    | Format | When                                |
| ------- | ------ | ----------------------------------- |
| `<dst>` | binary | when dst is a local filesystem path |

## API Routes

| Method | Path                                 | Auth         | Request body  | Response (used fields) |
| ------ | ------------------------------------ | ------------ | ------------- | ---------------------- |
| `POST` | `/storage/v1/object/{bucket}/{path}` | Bearer token | file contents | `{Key}`                |
| `GET`  | `/storage/v1/object/{bucket}/{path}` | Bearer token | none          | file contents          |

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
| `1`  | source file not found                 |
| `1`  | network / connection failure          |

## Output

### `--output-format text` (Go CLI compatible)

Prints progress and success message after object is copied.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Copies objects between local filesystem and Supabase Storage (or between Storage paths).
- `--recursive` / `-r` copies directories recursively.
- `--cache-control` sets custom Cache-Control header (default: `max-age=3600`).
- `--content-type` sets custom Content-Type header (default: auto-detected).
- `--jobs` / `-j` sets maximum number of parallel upload jobs.
- `--linked` (default) connects to linked project Storage API.
- `--local` connects to local database Storage API.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

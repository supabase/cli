# `supabase seed buckets`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML       | always, to read `[storage.buckets]` configuration |
| `~/.supabase/access-token`       | plain text | when `--linked` and `SUPABASE_ACCESS_TOKEN` unset |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                 | Auth         | Request body              | Response (used fields) |
| ------ | -------------------- | ------------ | ------------------------- | ---------------------- |
| `POST` | `/storage/v1/bucket` | Bearer token | `{id, name, public, ...}` | `{name}`               |

## Environment Variables

| Variable                | Purpose                          | Required?                                               |
| ----------------------- | -------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode   | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | config parsing failure                |

## Output

### `--output-format text` (Go CLI compatible)

Prints progress and success messages as buckets are created.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Seeds storage buckets declared in `[storage.buckets]` in `supabase/config.toml`.
- `--local` (default `true`) seeds the local database.
- `--linked` seeds the linked project.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

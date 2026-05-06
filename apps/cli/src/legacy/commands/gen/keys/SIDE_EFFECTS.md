# `supabase gen keys`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                          | Auth         | Request body | Response (used fields) |
| ------ | ----------------------------- | ------------ | ------------ | ---------------------- |
| `GET`  | `/v1/projects/{ref}/api-keys` | Bearer token | none         | `[{name, api_key}]`    |

## Environment Variables

| Variable                | Purpose                          | Required?                                               |
| ----------------------- | -------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token                       | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success — keys printed to stdout      |
| `1`  | authentication error (no token found) |
| `1`  | API error (non-2xx response)          |

## Output

### `--output-format text` (Go CLI compatible)

Prints key-value pairs in env format (default) or JSON.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- **Deprecated**: use `gen signing-key` instead.
- `--project-ref` flag specifies the project ref.
- `--override-name` overrides specific variable names in the output.
- Experimental command for generating preview branch keys.

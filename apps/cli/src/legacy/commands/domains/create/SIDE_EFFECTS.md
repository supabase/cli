# `supabase domains create`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                 | Auth         | Request body                | Response (used fields)                                                     |
| ------ | ------------------------------------ | ------------ | --------------------------- | -------------------------------------------------------------------------- |
| `POST` | `/v1/projects/{ref}/custom-hostname` | Bearer token | `{custom_hostname: string}` | `{custom_hostname, status, data: {result: {ownership_verification, ssl}}}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                      |
| ---- | -------------------------------------------------------------- |
| `0`  | success — custom hostname created and config printed           |
| `1`  | authentication error — no valid token found                    |
| `1`  | validation error — hostname does not have a valid CNAME record |
| `1`  | API error — non-2xx response from custom-hostname endpoint     |
| `1`  | network / connection failure                                   |

## Notes

- `--custom-hostname` flag is required.
- Before calling the API, validates that the hostname has a CNAME record pointing to the project's subdomain via Cloudflare DNS (1.1.1.1).
- `--include-raw-output` (deprecated, use `-o json` instead) includes the raw API response.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

# `supabase domains reverify`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                          | Auth         | Request body | Response (used fields)                                                     |
| ------ | --------------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------- |
| `POST` | `/v1/projects/{ref}/custom-hostname/reverify` | Bearer token | none         | `{custom_hostname, status, data: {result: {ownership_verification, ssl}}}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success — reverification result printed to stdout   |
| `1`  | authentication error — no valid token found         |
| `1`  | API error — non-2xx response from reverify endpoint |
| `1`  | network / connection failure                        |

## Notes

- Triggers re-verification of the custom hostname ownership via Cloudflare.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

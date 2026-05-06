# `supabase sso remove`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                                                         | Auth         | Request body | Response (used fields)                        |
| -------- | ------------------------------------------------------------ | ------------ | ------------ | --------------------------------------------- |
| `DELETE` | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none         | `{id, saml, domains, created_at, updated_at}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                            |
| ---- | ---------------------------------------------------- |
| `0`  | success — provider removed and details printed       |
| `1`  | authentication error — no valid token found          |
| `1`  | API error — 404 means provider ID does not exist     |
| `1`  | API error — non-2xx response from providers endpoint |
| `1`  | validation error — provider ID is not a valid UUID   |
| `1`  | network / connection failure                         |

## Notes

- The `<provider-id>` argument must be a valid UUID.
- Removing a provider will prevent existing SSO users from logging in.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

# `supabase sso info`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                                                  | Auth         | Request body | Response (used fields)                    |
| ------ | --------------------------------------------------------------------- | ------------ | ------------ | ----------------------------------------- |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}/metadata` | Bearer token | none         | SSO SAML service provider metadata fields |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success — SSO settings printed to stdout            |
| `1`  | authentication error — no valid token found         |
| `1`  | API error — non-2xx response from metadata endpoint |
| `1`  | network / connection failure                        |

## Notes

- Returns the SAML service provider metadata required to register the project with an identity provider.
- Includes entity ID, ACS URL, and metadata XML.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

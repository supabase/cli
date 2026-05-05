# `supabase sso list`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                           | Auth         | Request body | Response (used fields)                                   |
| ------ | ---------------------------------------------- | ------------ | ------------ | -------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers` | Bearer token | none         | `{items: [{id, saml, domains, created_at, updated_at}]}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                              |
| ---- | ------------------------------------------------------ |
| `0`  | success — providers printed to stdout                  |
| `1`  | authentication error — no valid token found            |
| `1`  | API error — 404 means SAML not enabled for the project |
| `1`  | API error — non-2xx response from providers endpoint   |
| `1`  | network / connection failure                           |

## Notes

- Returns 404 with a descriptive message when SAML 2.0 is not enabled for the project.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

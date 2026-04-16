# `supabase sso add`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<metadata-file>`          | XML                       | when `--metadata-file` flag is provided                    |
| `<attribute-mapping-file>` | JSON                      | when `--attribute-mapping-file` flag is provided           |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                           | Auth         | Request body                                                                     | Response (used fields)                        |
| ------ | ---------------------------------------------- | ------------ | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `POST` | `/v1/projects/{ref}/config/auth/sso/providers` | Bearer token | `{type, metadata_url, metadata_xml, domains, attribute_mapping, name_id_format}` | `{id, saml, domains, created_at, updated_at}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                            |
| ---- | ---------------------------------------------------- |
| `0`  | success — provider created and details printed       |
| `1`  | authentication error — no valid token found          |
| `1`  | API error — non-2xx response from providers endpoint |
| `1`  | validation error — invalid metadata URL or XML       |
| `1`  | network / connection failure                         |

## Notes

- `--type saml` is required (currently the only supported type).
- `--metadata-file` and `--metadata-url` are mutually exclusive.
- `--skip-url-validation` skips local DNS/HTTP validation of the metadata URL before sending to the API.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

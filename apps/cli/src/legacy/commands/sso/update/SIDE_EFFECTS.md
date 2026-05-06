# `supabase sso update`

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

| Method | Path                                                         | Auth         | Request body                                                                                            | Response (used fields)                        |
| ------ | ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none                                                                                                    | `{id, saml, domains, created_at, updated_at}` |
| `PUT`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | `{metadata_url, metadata_xml, domains, add_domains, remove_domains, attribute_mapping, name_id_format}` | `{id, saml, domains, created_at, updated_at}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                            |
| ---- | ---------------------------------------------------- |
| `0`  | success — provider updated and details printed       |
| `1`  | authentication error — no valid token found          |
| `1`  | API error — 404 means provider ID does not exist     |
| `1`  | API error — non-2xx response from providers endpoint |
| `1`  | validation error — provider ID is not a valid UUID   |
| `1`  | network / connection failure                         |

## Notes

- The `<provider-id>` argument must be a valid UUID.
- First performs a GET to retrieve existing provider state, then issues a PUT with merged domains.
- `--domains` replaces all existing domains.
- `--add-domains` and `--remove-domains` are relative to the existing domain list.
- `--domains` is mutually exclusive with `--add-domains` and `--remove-domains`.
- `--metadata-file` and `--metadata-url` are mutually exclusive.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

# `supabase config push`

## Files Read

| Path                             | Format                    | When                                                       |
| -------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`       | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/supabase/config.toml` | TOML                      | always, to load local project configuration                |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method  | Path                                | Auth         | Request body          | Response (used fields)                                    |
| ------- | ----------------------------------- | ------------ | --------------------- | --------------------------------------------------------- |
| `GET`   | `/v1/projects/{ref}/billing/addons` | Bearer token | none                  | `{available_addons: [{type, variants: [{name, price}]}]}` |
| `GET`   | `/v1/projects/{ref}/postgrest`      | Bearer token | none                  | PostgREST config object                                   |
| `PATCH` | `/v1/projects/{ref}/postgrest`      | Bearer token | PostgREST config diff | none                                                      |
| `GET`   | `/v1/projects/{ref}/config/auth`    | Bearer token | none                  | Auth config object                                        |
| `PATCH` | `/v1/projects/{ref}/config/auth`    | Bearer token | Auth config diff      | none                                                      |

Note: Additional config endpoints (storage, realtime, etc.) may be called depending on the config sections present in `config.toml`.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success — config pushed to the linked project                    |
| `1`  | malformed `config.toml`                                          |
| `1`  | user declined a confirmation prompt for a cost-incurring feature |
| `1`  | authentication error — no valid token found                      |
| `1`  | API error — non-2xx response from config endpoints               |
| `1`  | network / connection failure                                     |

## Output

### `--output-format text` (Go CLI compatible)

Prints project ref to stderr before pushing:

```
Pushing config to project: abcdefghijklmnopqrst
```

For cost-incurring features, prompts interactively:

```
Enabling GraphQL will cost you $75/month, then $10/month. Keep it enabled?
```

### `--output-format json`

Not applicable for this command (write operation).

### `--output-format stream-json`

Not applicable for this command (write operation).

## Notes

- Reads `config.toml` from the working directory (must be run from the project root).
- For features with cost (e.g. GraphQL add-on), prompts the user interactively before enabling.
- Uses `GET` + `PATCH` pairs for each config section to compare and apply only diffs.
- Requires `--project-ref` or a linked project.

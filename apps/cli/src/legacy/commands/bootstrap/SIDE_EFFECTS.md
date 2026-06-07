# `supabase bootstrap [template]`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path                             | Format | When                                                          |
| -------------------------------- | ------ | ------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always on success; created from selected template             |
| `<workdir>/.env`                 | env    | always on success; populated with API keys and project config |
| `<workdir>/<template files>`     | varies | template-specific files cloned or copied from GitHub          |

## API Routes

| Method | Path                                                      | Auth         | Request body                    | Response (used fields)                   |
| ------ | --------------------------------------------------------- | ------------ | ------------------------------- | ---------------------------------------- |
| `GET`  | `https://api.github.com/repos/supabase/samples/contents/` | none         | none                            | `[{name, type, ...}]` (template listing) |
| `POST` | `/v1/projects`                                            | Bearer token | `{name, region, db_pass, plan}` | `{id, ref, ...}`                         |
| `GET`  | `/v1/projects/{ref}/api-keys`                             | Bearer token | none                            | `[{name, api_key}]`                      |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |
| `WORKDIR`               | target directory for bootstrapping                   | no (prompts interactively if not set)                   |
| `DB_PASSWORD`           | database password (bound from `--password` flag)     | no (generated if not provided)                          |

## Exit Codes

| Code | Condition                                                         |
| ---- | ----------------------------------------------------------------- |
| `0`  | success — project created, files written, start command suggested |
| `1`  | invalid template name provided as argument                        |
| `1`  | GitHub API unavailable for template listing                       |
| `1`  | authentication error — no valid token found for project creation  |
| `1`  | project creation failure (API error)                              |
| `1`  | network / connection failure                                      |

## Output

### `--output-format text` (Go CLI compatible)

Interactive prompts for working directory and template selection (if not provided). On success, prints project details and suggested start command:

```
To start your app:
  <start command>
```

### `--output-format json`

Not applicable — bootstrap is an interactive command.

### `--output-format stream-json`

Not applicable — bootstrap is an interactive command.

## Notes

- Accepts an optional positional `[template]` argument to skip template selection prompt.
- Without `WORKDIR`, prompts the user to enter a directory (defaulting to `CurrentDirAbs`).
- Templates are fetched from `https://api.github.com/repos/supabase/samples/contents/`.
- A "scratch" (empty) template is always available as fallback without GitHub access.
- The `--password` flag sets the database password, bound to `DB_PASSWORD` viper key.
- On success, the Go CLI prints a suggestion like `To start your app: supabase start`.

# `supabase link`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `.supabase/config.json`    | JSON                      | when present, to load existing local config                |
| `supabase/config.toml`     | TOML                      | to load project configuration for the link operation       |

## Files Written

| Path                     | Format | When                                                    |
| ------------------------ | ------ | ------------------------------------------------------- |
| `.supabase/project.json` | JSON   | always on success; stores linked project ref and config |
| `supabase/config.toml`   | TOML   | when config differs from remote; updated with remote    |

## API Routes

| Method | Path                                          | Auth         | Request body | Response (used fields)                      |
| ------ | --------------------------------------------- | ------------ | ------------ | ------------------------------------------- |
| `GET`  | `/v1/projects/{ref}`                          | Bearer token | none         | `{status, database.host, database.version}` |
| `GET`  | `/v1/projects/{ref}/api-keys`                 | Bearer token | none         | `[{name, api_key}]`                         |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none         | `{max_connections, ...}`                    |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |
| `PROJECT_ID`            | override `--project-ref` flag                        | no                                                      |
| `DB_PASSWORD`           | database password (bound from `--password` flag)     | no                                                      |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success — project linked, prints "Finished supabase link."       |
| `1`  | authentication error — no valid token found                      |
| `1`  | project not found — API returns 404                              |
| `1`  | project not active or unhealthy                                  |
| `1`  | missing `--project-ref` in non-TTY mode without `PROJECT_ID` env |
| `1`  | network / connection failure                                     |

## Output

### `--output-format text` (Go CLI compatible)

On success, prints a confirmation message:

```
Finished supabase link.
```

Interactive mode may prompt for project selection and database password.

### `--output-format json`

Not applicable — link is an interactive command.

### `--output-format stream-json`

Not applicable — link is an interactive command.

## Notes

- In non-TTY mode without `PROJECT_ID` env, `--project-ref` is required.
- The `--skip-pooler` flag uses a direct database connection instead of the connection pooler.
- The `--password` flag sets the database password, bound to `DB_PASSWORD` viper key.
- After linking, the project ref is written to `.supabase/project.json` (and legacy `.supabase/` state).
- The `PostRun` hook always prints "Finished supabase link." to stdout on success.

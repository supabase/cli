# `supabase services`

## Files Read

| Path                       | Format     | When                                                                          |
| -------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `.supabase/project.json`   | JSON       | to resolve linked project ref for remote version check                        |
| `supabase/config.toml`     | TOML       | to read local service image versions                                          |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable (for linked check) |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                           | Auth         | Request body | Response (used fields)                                  |
| ------ | ---------------------------------------------- | ------------ | ------------ | ------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/api-keys`                  | Bearer token | none         | `[{name, api_key}]` (used to authenticate tenant calls) |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none         | `{database.version}` (postgres image version)           |
| `GET`  | `https://{ref}.supabase.co/auth/v1/health`     | service key  | none         | `{version}` (auth service version)                      |
| `GET`  | `https://{ref}.supabase.co/rest/v1/`           | service key  | none         | `{info.version}` (postgrest version)                    |
| `GET`  | `https://{ref}.supabase.co/storage/v1/version` | service key  | none         | body as plain text (storage version)                    |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for Management API (linked version check) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success — local service versions printed; remote versions shown if linked |
| `0`  | not linked — local versions still printed, remote column shows `-`        |
| `1`  | `--output env` format — explicitly not supported (`ErrEnvNotSupported`)   |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table to stdout with local and linked (remote) service image versions:

```
|SERVICE IMAGE|LOCAL|LINKED|
|-|-|-|
|`supabase/postgres:15.1.0.117`|`15.1.0.117`|`15.1.0.117`|
|`supabase/gotrue:v2.74.2`|`v2.74.2`|`-`|
```

### `--output-format json`

Not defined in Go CLI. Emits structured service version data as JSON.

### `--output-format stream-json`

Not defined in Go CLI. Emits NDJSON result event.

## Notes

- The remote version check is best-effort: failures are printed to stderr but do not cause a non-zero exit.
- If the project is not linked, the LINKED column shows `-` for all services.
- Uses concurrent requests to check remote service versions via a work queue.
- The Go CLI also supports `--output toml` (TOML format) and `--output json` via `utils.OutputFormat`.
- The `--output env` format is explicitly unsupported and returns `ErrEnvNotSupported`.

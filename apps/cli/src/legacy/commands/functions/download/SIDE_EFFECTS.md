# `supabase functions download [Function name]`

## Files Read

| Path                       | Format     | When                                                       |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path                                                | Format | When                                     |
| --------------------------------------------------- | ------ | ---------------------------------------- |
| `<workdir>/supabase/functions/<slug>/<remote path>` | bytes  | for each source file returned by the API |

## API Routes

| Method | Path                                       | Auth         | Request body | Response (used fields)                     |
| ------ | ------------------------------------------ | ------------ | ------------ | ------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/functions`             | Bearer token | none         | function slugs, when downloading all       |
| `GET`  | `/v1/projects/{ref}/functions/{slug}`      | Bearer token | none         | entrypoint path, when absent from metadata |
| `GET`  | `/v1/projects/{ref}/functions/{slug}/body` | Bearer token | none         | multipart function source                  |

## Subprocesses

| Command                              | When                                | Purpose                             |
| ------------------------------------ | ----------------------------------- | ----------------------------------- |
| `supabase-go functions download ...` | `--use-docker` or `--legacy-bundle` | preserve hidden compatibility modes |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | network / connection failure          |

## Output

### `--output-format text` (Go CLI compatible)

Prints progress and success messages as functions are downloaded.

### `--output-format json`

Prints a structured success result with the downloaded function slugs and project ref.

### `--output-format stream-json`

Prints a structured success result with the downloaded function slugs and project ref.

## Notes

- If no function name is provided, downloads all functions.
- Requires a linked project (`--project-ref` or linked project config).
- Native downloads reject path traversal and symlink escapes before writing source files.
- `--use-docker` and `--legacy-bundle` are hidden flags forwarded to the Go binary for backward compatibility; they are mutually exclusive with `--use-api`.
- Refreshes the linked-project telemetry cache and flushes telemetry state after resolving a project ref.

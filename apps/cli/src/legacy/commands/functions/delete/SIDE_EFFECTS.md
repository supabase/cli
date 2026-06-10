# `supabase functions delete <Function name>`

## Files Read

| Path                       | Format     | When                                                       |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                                  | Auth         | Request body | Response (used fields) |
| -------- | ------------------------------------- | ------------ | ------------ | ---------------------- |
| `DELETE` | `/v1/projects/{ref}/functions/{slug}` | Bearer token | none         | none                   |

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

Prints a success message after the function is deleted.

### `--output-format json`

Prints a structured success result with the function slug and project ref.

### `--output-format stream-json`

Prints a structured success result with the function slug and project ref.

## Notes

- Requires exactly one argument: the function slug/name.
- Does NOT remove the function from the local filesystem.
- Requires a linked project (`--project-ref` or linked project config).
- Runs natively in TypeScript through the Management API.
- Refreshes the linked-project telemetry cache and flushes telemetry state after resolving a project ref.

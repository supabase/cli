# `supabase branches disable`

## Files Read

| Path                              | Format                    | When                                                       |
| --------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/.supabase/config.json` | JSON                      | always, to resolve linked project ref                      |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                          | Auth         | Request body | Response (used fields) |
| -------- | ----------------------------- | ------------ | ------------ | ---------------------- |
| `DELETE` | `/v1/projects/{ref}/branches` | Bearer token | none         | none                   |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — branching disabled for the project                    |
| `1`  | authentication error — no valid token found                     |
| `1`  | API error — non-2xx response from `/v1/projects/{ref}/branches` |
| `1`  | network / connection failure                                    |

## Output

### `--output-format text` (Go CLI compatible)

No output on success (exit 0).

### `--output-format json`

No structured output on success.

### `--output-format stream-json`

No structured output on success.

## Notes

- This command is hidden in the Go CLI (`Hidden: true`).
- No positional arguments. Uses `--project-ref` or reads from `.supabase/config.json`.
- Disables preview branching for the entire linked project (not a single branch).

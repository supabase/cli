# `supabase branches pause`

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

| Method | Path                             | Auth         | Request body | Response (used fields) |
| ------ | -------------------------------- | ------------ | ------------ | ---------------------- |
| `POST` | `/v1/branches/{branch_id}/pause` | Bearer token | none         | none                   |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                          |
| ---- | ------------------------------------------------------------------ |
| `0`  | success — branch paused                                            |
| `1`  | authentication error — no valid token found                        |
| `1`  | API error — non-2xx response from `/v1/branches/{branch_id}/pause` |
| `1`  | network / connection failure                                       |
| `1`  | branch not found                                                   |

## Output

### `--output-format text` (Go CLI compatible)

No output on success (exit 0).

### `--output-format json`

No structured output on success.

### `--output-format stream-json`

No structured output on success.

## Notes

- Accepts optional positional `[name]` argument (branch name or ID). If omitted in interactive mode, prompts the user to select a branch.
- The Go CLI internally resolves a branch name to a project ref by calling `/v1/projects/{ref}/branches/{name}` first, then POSTs to `/v1/projects/{branch_project_ref}/pause`.

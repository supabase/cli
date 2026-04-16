# `supabase branches update`

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

| Method  | Path                       | Auth         | Request body                                                     | Response (used fields)                 |
| ------- | -------------------------- | ------------ | ---------------------------------------------------------------- | -------------------------------------- |
| `PATCH` | `/v1/branches/{branch_id}` | Bearer token | `{branch_name?, git_branch?, persistent?, status?, notify_url?}` | `{id, name, status, project_ref, ...}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                    |
| ---- | ------------------------------------------------------------ |
| `0`  | success — branch updated and details printed to stdout       |
| `1`  | authentication error — no valid token found                  |
| `1`  | API error — non-2xx response from `/v1/branches/{branch_id}` |
| `1`  | network / connection failure                                 |
| `1`  | branch not found                                             |

## Output

### `--output-format text` (Go CLI compatible)

Prints a table with columns: `ID`, `NAME`, `DEFAULT`, `GIT BRANCH`, `WITH DATA`, `STATUS`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`.

### `--output-format json`

Single JSON object emitted to stdout on success containing the updated branch response.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Flags: `[name]` (positional branch name or ID), `--name`, `--git-branch`, `--persistent`, `--status`, `--notify-url`, `--project-ref`.
- If the positional argument is not provided in interactive mode, the user is prompted to select a branch.

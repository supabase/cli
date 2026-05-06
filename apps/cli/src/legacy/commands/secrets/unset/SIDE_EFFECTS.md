# `supabase secrets unset`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                         | Auth         | Request body    | Response (used fields) |
| -------- | ---------------------------- | ------------ | --------------- | ---------------------- |
| `GET`    | `/v1/projects/{ref}/secrets` | Bearer token | none            | `[{name, value}]`      |
| `DELETE` | `/v1/projects/{ref}/secrets` | Bearer token | `["NAME", ...]` | none (200 expected)    |

Note: `GET` is only called when no secret names are passed as arguments (to fetch all non-SUPABASE\_ secrets).

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                          |
| ---- | ------------------------------------------------------------------ |
| `0`  | success — secrets unset from the linked project                    |
| `0`  | no secrets to unset (all existing secrets have `SUPABASE_` prefix) |
| `1`  | user declined the confirmation prompt                              |
| `1`  | authentication error — no valid token found                        |
| `1`  | API error — non-2xx response from secrets endpoint                 |
| `1`  | network / connection failure                                       |

## Output

### `--output-format text` (Go CLI compatible)

Prompts for confirmation before unsetting, then prints a confirmation message to stdout.

```
Finished supabase secrets unset.
```

If no secrets to unset, prints to stderr:

```
You have not set any function secrets, nothing to do.
```

### `--output-format json`

Not applicable for this command (write operation).

### `--output-format stream-json`

Not applicable for this command (write operation).

## Notes

- When called without arguments, unsets all secrets that do not have a `SUPABASE_` prefix.
- Requires interactive confirmation before deleting.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

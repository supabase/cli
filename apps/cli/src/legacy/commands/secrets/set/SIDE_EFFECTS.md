# `supabase secrets set`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<env-file>`               | `.env` format             | when `--env-file` flag is provided                         |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                         | Auth         | Request body                           | Response (used fields) |
| ------ | ---------------------------- | ------------ | -------------------------------------- | ---------------------- |
| `POST` | `/v1/projects/{ref}/secrets` | Bearer token | `[{name: string, value: string}, ...]` | none (201 expected)    |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success — secrets set on the linked project         |
| `1`  | no secrets provided (no args and no `--env-file`)   |
| `1`  | malformed secret pair (must be `NAME=VALUE` format) |
| `1`  | authentication error — no valid token found         |
| `1`  | API error — non-2xx response from secrets endpoint  |
| `1`  | network / connection failure                        |

## Output

### `--output-format text` (Go CLI compatible)

Prints a confirmation message to stdout on success.

```
Finished supabase secrets set.
```

Skips secrets with names starting with `SUPABASE_` (writes warning to stderr).

### `--output-format json`

Not applicable for this command (write operation).

### `--output-format stream-json`

Not applicable for this command (write operation).

## Notes

- Accepts secrets as positional `NAME=VALUE` pairs or via `--env-file`.
- Secrets with names starting with `SUPABASE_` are silently skipped.
- Also reads from `config.toml` edge runtime secrets when available.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

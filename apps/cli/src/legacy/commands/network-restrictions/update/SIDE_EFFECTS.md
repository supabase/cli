# `supabase network-restrictions update`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                      | Auth         | Request body                                           | Response (used fields)          |
| ------ | ----------------------------------------- | ------------ | ------------------------------------------------------ | ------------------------------- |
| `POST` | `/v1/projects/{ref}/network-restrictions` | Bearer token | `{allowed_cidr_ranges: string[], bypass_cidr_checks?}` | `{allowed_cidr_ranges, status}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — network restrictions updated                          |
| `1`  | authentication error — no valid token found                     |
| `1`  | API error — non-2xx response from network restrictions endpoint |
| `1`  | invalid CIDR address provided                                   |
| `1`  | network / connection failure                                    |

## Output

### `--output-format text` (Go CLI compatible)

Prints updated network restriction configuration to stdout.

### `--output-format json`

Single JSON object emitted to stdout on success.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Flags: `--db-allow-cidr` (repeatable), `--bypass-cidr-checks`, `--append`.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- By default, replaces all existing restrictions. Use `--append` to merge.

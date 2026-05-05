# `supabase network-bans remove`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                              | Auth         | Request body                 | Response (used fields) |
| -------- | --------------------------------- | ------------ | ---------------------------- | ---------------------- |
| `DELETE` | `/v1/projects/{ref}/network-bans` | Bearer token | `{ipv4_addresses: string[]}` | none                   |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                               |
| ---- | ------------------------------------------------------- |
| `0`  | success — network ban removed                           |
| `1`  | authentication error — no valid token found             |
| `1`  | API error — non-2xx response from network bans endpoint |
| `1`  | network / connection failure                            |

## Output

### `--output-format text` (Go CLI compatible)

Prints "Successfully removed network bans." to stdout.

### `--output-format json`

Single JSON object emitted to stdout on success.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Requires `--db-unban-ip` flag to specify IP(s) to unban (repeatable).
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

# `supabase ssl-enforcement update`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                        | Auth         | Request body          | Response (used fields)         |
| ------ | ------------------------------------------- | ------------ | --------------------- | ------------------------------ |
| `PUT`  | `/v1/projects/{ref}/config/ssl-enforcement` | Bearer token | `{enforced: boolean}` | `{enforced, override_enabled}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                                              |
| ---- | -------------------------------------------------------------------------------------- |
| `0`  | success — SSL enforcement config updated                                               |
| `1`  | authentication error — no valid token found                                            |
| `1`  | neither `--enable-db-ssl-enforcement` nor `--disable-db-ssl-enforcement` was specified |
| `1`  | API error — non-2xx response from SSL enforcement endpoint                             |
| `1`  | network / connection failure                                                           |

## Output

### `--output-format text` (Go CLI compatible)

Prints updated SSL enforcement configuration to stdout.

### `--output-format json`

Single JSON object emitted to stdout on success.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Flags `--enable-db-ssl-enforcement` and `--disable-db-ssl-enforcement` are mutually exclusive.
- Exactly one of the two flags must be specified.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

# `supabase vanity-subdomains activate`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                           | Auth         | Request body                 | Response (used fields) |
| ------ | ---------------------------------------------- | ------------ | ---------------------------- | ---------------------- |
| `POST` | `/v1/projects/{ref}/vanity-subdomain/activate` | Bearer token | `{vanity_subdomain: string}` | `{subdomain, status}`  |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success — vanity subdomain activated                |
| `1`  | authentication error — no valid token found         |
| `1`  | API error — non-2xx response from activate endpoint |
| `1`  | network / connection failure                        |

## Output

### `--output-format text` (Go CLI compatible)

Prints activation result to stdout.

### `--output-format json`

Single JSON object emitted to stdout on success.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Requires `--desired-subdomain` flag (mandatory).
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- After activation, the project's auth services will no longer function on the `{project-ref}.{supabase-domain}` hostname.

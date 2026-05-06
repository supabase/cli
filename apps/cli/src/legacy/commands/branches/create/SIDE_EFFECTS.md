# `supabase branches create`

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

| Method | Path                          | Auth         | Request body                                                                            | Response (used fields) |
| ------ | ----------------------------- | ------------ | --------------------------------------------------------------------------------------- | ---------------------- |
| `POST` | `/v1/projects/{ref}/branches` | Bearer token | `{branch_name?, region?, desired_instance_size?, persistent?, with_data?, notify_url?}` | `{id}`                 |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — branch created                                        |
| `1`  | authentication error — no valid token found                     |
| `1`  | API error — non-2xx response from `/v1/projects/{ref}/branches` |
| `1`  | network / connection failure                                    |

## Output

### `--output-format text` (Go CLI compatible)

Prints the created branch ID to stdout.

### `--output-format json`

Single JSON object emitted to stdout on success containing the branch response.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Flags: `[name]` (positional), `--region`, `--size`, `--persistent`, `--with-data`, `--notify-url`, `--project-ref`.
- Requires a linked project (reads `--project-ref` or `.supabase/config.json`).

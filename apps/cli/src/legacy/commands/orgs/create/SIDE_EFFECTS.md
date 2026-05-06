# `supabase orgs create`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                | Auth         | Request body     | Response (used fields)       |
| ------ | ------------------- | ------------ | ---------------- | ---------------------------- |
| `POST` | `/v1/organizations` | Bearer token | `{name: string}` | `{id: string, name: string}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                             |
| ---- | ----------------------------------------------------- |
| `0`  | success — organization created                        |
| `1`  | authentication error — no valid token found           |
| `1`  | API error — non-2xx response from `/v1/organizations` |
| `1`  | network / connection failure                          |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Created organization: <id>` followed by a Markdown-style table to stdout.
Table has a header row and one row for the created organization.
Column order: `ID`, `NAME`.

```
Created organization: combined-fuchsia-lion
 ID                    NAME
 combined-fuchsia-lion  My Test Org
```

### `--output-format json`

Single JSON object emitted to stdout on success containing the full organization
object as returned by the Management API.

```json
{ "id": "combined-fuchsia-lion", "name": "My Test Org" }
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{"id":"combined-fuchsia-lion","name":"My Test Org"}}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- Takes exactly one positional argument: the organization name.
- No `--project-ref` flag. `orgs create` is a user-level command.
- The organization ID in the response is a human-readable slug (e.g. `combined-fuchsia-lion`), not a UUID.

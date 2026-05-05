# `supabase orgs list`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                | Auth         | Request body | Response (used fields)         |
| ------ | ------------------- | ------------ | ------------ | ------------------------------ |
| `GET`  | `/v1/organizations` | Bearer token | none         | `[{id: string, name: string}]` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                             |
| ---- | ----------------------------------------------------- |
| `0`  | success — organizations printed to stdout             |
| `1`  | authentication error — no valid token found           |
| `1`  | API error — non-2xx response from `/v1/organizations` |
| `1`  | network / connection failure                          |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table to stdout with a header row and one row per organization.
Column order: `ID`, `NAME`. Columns are separated by two spaces and left-aligned.
No trailing newline after the last row (matches Go CLI behavior).

```
 ID                                    NAME
 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  My Org
 yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy  Another Org
```

### `--output-format json`

Single JSON array emitted to stdout on success. Each element contains the full
organization object as returned by the Management API.

```json
[
  { "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "name": "My Org" },
  { "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", "name": "Another Org" }
]
```

### `--output-format stream-json`

One `result` event on success. No intermediate `log` events (the request is a single fast
API call with no multi-step progress).

```ndjson
{"type":"result","data":[{"id":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","name":"My Org"}]}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- No `--project-ref` flag. `orgs list` is a user-level command — it lists all organizations
  the authenticated user has access to, regardless of any linked project.
- The result set is determined entirely by the access token's scope; no local config is read
  beyond resolving the token itself.
- The Go CLI also supports `--output toml` and `--output json` via its own flag. The
  TypeScript port uses the global `--output-format` flag instead. The `toml` format is not
  reproduced (not part of the compatibility contract for scripted workflows).

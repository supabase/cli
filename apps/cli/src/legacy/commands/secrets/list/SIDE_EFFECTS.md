# `supabase secrets list`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                         | Auth         | Request body | Response (used fields)              |
| ------ | ---------------------------- | ------------ | ------------ | ----------------------------------- |
| `GET`  | `/v1/projects/{ref}/secrets` | Bearer token | none         | `[{name, value}]` (value is digest) |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                          |
| ---- | -------------------------------------------------- |
| `0`  | success — secrets printed to stdout                |
| `1`  | authentication error — no valid token found        |
| `1`  | API error — non-2xx response from secrets endpoint |
| `1`  | network / connection failure                       |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table to stdout with a header row and one row per secret.
Column order: `NAME`, `DIGEST`. Columns are separated by `|`.

```
|NAME|DIGEST|
|-|-|
|`MY_SECRET`|`dummy-digest-value`|
```

### `--output-format json`

Single JSON array emitted to stdout on success. Each element contains the name and digest value.

```json
[
  {
    "name": "MY_SECRET",
    "value": "dummy-digest-value"
  }
]
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":[{"name":"MY_SECRET","value":"dummy-digest-value"}]}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- The `value` field returned by the API is a digest/hash of the secret, not the plaintext value.
- Results are sorted alphabetically by name.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).

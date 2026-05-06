# `supabase snippets list`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path           | Auth         | Request body | Response (used fields)                                                         |
| ------ | -------------- | ------------ | ------------ | ------------------------------------------------------------------------------ |
| `GET`  | `/v1/snippets` | Bearer token | none         | `{data: [{id, name, visibility, owner: {username}, inserted_at, updated_at}]}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                        |
| ---- | ------------------------------------------------ |
| `0`  | success — snippet list printed to stdout         |
| `1`  | authentication error — no valid token found      |
| `1`  | API error — non-2xx response from `/v1/snippets` |
| `1`  | network / connection failure                     |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table with columns: `ID`, `NAME`, `VISIBILITY`, `OWNER`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`.

```
 ID           | NAME         | VISIBILITY | OWNER    | CREATED AT (UTC)    | UPDATED AT (UTC)
 test-snippet | Create table | user       | supaseed | 2023-10-13 17:48:58 | 2023-10-13 17:48:58
```

### `--output-format json`

Single JSON object with the full snippets list response.

```json
{"data": [{"id": "…", "name": "…", "visibility": "user", …}]}
```

### `--output-format stream-json`

One `result` event on success.

## Notes

- Requires `--project-ref` or a linked project.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary via `LegacyGoProxy`.

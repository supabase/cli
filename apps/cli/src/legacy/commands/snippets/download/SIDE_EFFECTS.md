# `supabase snippets download`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                | Auth         | Request body | Response (used fields)     |
| ------ | ------------------- | ------------ | ------------ | -------------------------- |
| `GET`  | `/v1/snippets/{id}` | Bearer token | none         | `{content: {sql: string}}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                               |
| ---- | ------------------------------------------------------- |
| `0`  | success — SQL content printed to stdout                 |
| `1`  | invalid snippet ID argument (empty or not a valid UUID) |
| `1`  | authentication error — no valid token found             |
| `1`  | API error — non-2xx response from `/v1/snippets/{id}`   |
| `1`  | network / connection failure                            |

## Output

### `--output-format text` (Go CLI compatible)

Prints the raw SQL content of the snippet to stdout, followed by a newline.

```
select 1
```

### `--output-format json`

Not applicable — download writes SQL directly to stdout.

### `--output-format stream-json`

Not applicable — download writes SQL directly to stdout.

## Notes

- Requires a `<snippet-id>` positional argument (UUID).
- Requires `--project-ref` or a linked project.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary via `LegacyGoProxy`.

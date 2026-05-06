# `supabase projects list`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path           | Auth         | Request body | Response (used fields)                                                             |
| ------ | -------------- | ------------ | ------------ | ---------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects` | Bearer token | none         | `[{id, organization_slug, name, region, created_at, cloud_provider, status, ...}]` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                        |
| ---- | ------------------------------------------------ |
| `0`  | success — projects printed to stdout             |
| `1`  | authentication error — no valid token found      |
| `1`  | API error — non-2xx response from `/v1/projects` |
| `1`  | network / connection failure                     |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table to stdout with a header row and one row per project.
Column order: `ID`, `NAME`, `REGION`, `ORGANIZATION ID`, `CREATED AT`. Columns are
separated by two spaces and left-aligned.

```
 ID                    NAME          REGION      ORGANIZATION ID            CREATED AT
 abcdefghijklmnopqrst  Test Project  us-west-1   combined-fuchsia-lion      2022-04-25T02:14:55.906498Z
```

### `--output-format json`

Single JSON array emitted to stdout on success. Each element contains the full
project object as returned by the Management API.

```json
[
  {
    "id": "abcdefghijklmnopqrst",
    "organization_slug": "combined-fuchsia-lion",
    "name": "Test Project",
    "region": "us-west-1",
    "created_at": "2022-04-25T02:14:55.906498Z"
  }
]
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":[{"id":"abcdefghijklmnopqrst","name":"Test Project","region":"us-west-1","organization_slug":"combined-fuchsia-lion","created_at":"2022-04-25T02:14:55.906498Z"}]}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- No `--project-ref` flag. `projects list` is a user-level command — it lists all projects
  the authenticated user has access to.
- The result set is determined entirely by the access token's scope.

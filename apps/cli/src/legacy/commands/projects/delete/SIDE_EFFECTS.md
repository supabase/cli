# `supabase projects delete`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                 | Auth         | Request body | Response (used fields)        |
| -------- | -------------------- | ------------ | ------------ | ----------------------------- |
| `DELETE` | `/v1/projects/{ref}` | Bearer token | none         | `{ref: string, name: string}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                  |
| ---- | ---------------------------------------------------------- |
| `0`  | success — project deleted                                  |
| `1`  | authentication error — no valid token found                |
| `1`  | project not found — 404 response from `/v1/projects/{ref}` |
| `1`  | API error — non-2xx/404 response from `/v1/projects/{ref}` |
| `1`  | network / connection failure                               |

## Flags

| Flag    | Type | Required (non-interactive) | Description                        |
| ------- | ---- | -------------------------- | ---------------------------------- |
| `[ref]` | arg  | yes (non-interactive)      | Project ref to delete (positional) |

## Output

### `--output-format text` (Go CLI compatible)

Prints a confirmation message on successful deletion.

### `--output-format json`

Single JSON object emitted to stdout on success.

```json
{ "ref": "abcdefghijklmnopqrst", "name": "my-project" }
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{"ref":"abcdefghijklmnopqrst","name":"my-project"}}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- In interactive mode (when stdin is a TTY and no ref is provided), the CLI prompts the
  user to select a project to delete.
- In non-interactive mode (when stdin is not a TTY), the project ref positional argument
  is required.
- A `PreRun` check is performed before the DELETE call to validate the project ref and
  display a confirmation prompt in interactive mode.

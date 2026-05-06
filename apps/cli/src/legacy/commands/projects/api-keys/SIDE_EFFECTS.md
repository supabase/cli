# `supabase projects api-keys`

## Files Read

| Path                              | Format                    | When                                                                     |
| --------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `~/.supabase/access-token`        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable               |
| `<workdir>/.supabase/config.json` | JSON                      | when `--project-ref` flag is not provided, to resolve linked project ref |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                          | Auth         | Request body | Response (used fields)                      |
| ------ | ----------------------------- | ------------ | ------------ | ------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/api-keys` | Bearer token | none         | `[{name: string, api_key: string \| null}]` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Flags

| Flag            | Type   | Required | Description                                                                 |
| --------------- | ------ | -------- | --------------------------------------------------------------------------- |
| `--project-ref` | string | no       | Project ref of the Supabase project (resolved from linked config if absent) |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — API keys printed to stdout                            |
| `1`  | authentication error — no valid token found                     |
| `1`  | API error — non-2xx response from `/v1/projects/{ref}/api-keys` |
| `1`  | network / connection failure                                    |
| `1`  | project ref not provided and no linked project found            |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Markdown-style table to stdout with a header row and one row per API key.
Column order: `NAME`, `API KEY`. Null API keys are shown as empty.

```
 NAME          API KEY
 anon          eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 service_role  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### `--output-format json`

Single JSON array emitted to stdout on success.

```json
[
  { "name": "anon", "api_key": "eyJ..." },
  { "name": "service_role", "api_key": "eyJ..." }
]
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":[{"name":"anon","api_key":"eyJ..."},{"name":"service_role","api_key":"eyJ..."}]}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- API keys with null values (as returned by the API for redacted keys) are shown as
  empty strings in text mode output.
- The `--project-ref` flag is optional when the CLI is linked to a project via `supabase link`.

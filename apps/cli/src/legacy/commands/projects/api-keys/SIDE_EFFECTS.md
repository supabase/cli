# `supabase projects api-keys`

## Files Read

| Path                                   | Format                    | When                                                                    |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable              |
| `<workdir>/supabase/.temp/project-ref` | plain text (ref string)   | when `--project-ref` is not provided, to resolve the linked project ref |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                        | Auth         | Request body | Response (used fields)                      |
| ------ | ------------------------------------------- | ------------ | ------------ | ------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/api-keys[?reveal=true]` | Bearer token | none         | `[{name: string, api_key: string \| null}]` |

The `reveal=true` query param is sent only when `--reveal` is passed; it instructs the
Management API to return the full secret keys (`sb_secret_...`) in `api_key` instead of
`null`. Without `--reveal` the param is omitted entirely (default request).

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Flags

| Flag            | Type    | Required | Description                                                                 |
| --------------- | ------- | -------- | --------------------------------------------------------------------------- |
| `--project-ref` | string  | no       | Project ref of the Supabase project (resolved from linked config if absent) |
| `--reveal`      | boolean | no       | Reveal the secret API keys in full (sends `reveal=true`); default redacted  |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — API keys printed to stdout                            |
| `1`  | authentication error — no valid token found                     |
| `1`  | API error — non-2xx response from `/v1/projects/{ref}/api-keys` |
| `1`  | network / connection failure                                    |
| `1`  | project ref not provided and no linked project found            |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                            |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` is telemetry-safe; `--reveal`'s boolean value is logged but never the key values) |

## Output

Two-axis: Go's `--output {pretty|json|yaml|toml|env}` wins when set; otherwise the TS
`--output-format`. go toml/env encode a `SUPABASE_<NAME>_KEY` env map; go json/yaml
encode the raw `ApiKeyResponse[]`.

### `--output-format text` (Go CLI compatible)

Glamour ASCII table. Column order: `NAME`, `KEY VALUE`. A null api key renders as `******`.

```
  NAME         | KEY VALUE
  -------------|-------------------------------------------
  anon         | eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  service_role | ******
```

### `--output-format json`

`success("", { keys })` — the raw `ApiKeyResponse[]` under a `keys` field.

```json
{
  "keys": [
    { "name": "anon", "api_key": "eyJ..." },
    { "name": "service_role", "api_key": null }
  ]
}
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{"keys":[{"name":"anon","api_key":"eyJ..."},{"name":"service_role","api_key":null}]}}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- API keys with null values (redacted by the API) render as `******` in text mode and
  in the toml/env env map; the json/yaml encodings preserve the raw `null`. Passing
  `--reveal` makes the API return the secret values, so they print in full across all
  formats (issue #4775). This is a TS-only flag with no Go CLI equivalent.
- The `--project-ref` flag is optional when the CLI is linked to a project via `supabase link`.
  When omitted, the ref is resolved flag → env → `.temp/project-ref` → prompt on a TTY,
  failing with a not-linked error otherwise.

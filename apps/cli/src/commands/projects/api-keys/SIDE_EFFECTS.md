# `supabase projects api-keys`

## Files Read

| Path                                   | Format                    | When                                                                                                                                                  |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                            |
| `<workdir>/supabase/.temp/project-ref` | plain text (ref string)   | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` are not provided, to resolve the linked project ref, and as the linked parent for `--remote=<branch>` |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                        | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{parent}/branches`            | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`                         | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `GET`  | `/v1/projects/{ref}/api-keys[?reveal=true]` | Bearer token | none         | `[{name: string, api_key: string \| null}]`                                                                                                                                                                                                              |

The `reveal=true` query param is sent only when `--reveal` is passed; it instructs the
Management API to return the full secret keys (`sb_secret_...`) in `api_key` instead of
`null`. Without `--reveal` the param is omitted entirely (default request).

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |

## Flags

| Flag            | Type    | Required | Description                                                                                                                                                   |
| --------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--remote`      | string  | no       | Project to read keys from: `--remote=<ref>`, `--remote=<branch>` of the linked project, or a bare `--remote` for the linked project (linked config if absent) |
| `--project-ref` | string  | no       | Deprecated hidden alias of `--remote=<ref>`; prints a deprecation warning on stderr                                                                           |
| `--reveal`      | boolean | no       | Reveal the secret API keys in full (sends `reveal=true`); default redacted                                                                                    |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — API keys printed to stdout                                                                                                                                                                                   |
| `1`  | authentication error — no valid token found                                                                                                                                                                            |
| `1`  | API error — non-2xx response from `/v1/projects/{ref}/api-keys`                                                                                                                                                        |
| `1`  | network / connection failure                                                                                                                                                                                           |
| `1`  | project ref not provided and no linked project found                                                                                                                                                                   |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` is recorded only when it is ref-shaped; `--reveal`'s boolean value is logged but never the key values) |

## Output

Two-axis: `--output {pretty|json|yaml|toml|env}` wins when set; otherwise
`--output-format`. `--output toml/env` encode a `SUPABASE_<NAME>_KEY` env map;
`--output json/yaml` encode the raw `ApiKeyResponse[]`.

### `--output-format text`

ASCII table. Column order: `NAME`, `KEY VALUE`. A null api key renders as `******`.

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
  formats (issue #4775).
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker; it fails with a not-linked error otherwise. A
  bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase projects api-keys` takes a project, not a database); `false|no|off|0` and `--no-remote` fail with `--remote doesn't take false. Leave it out to use the linked project.`, and an empty value with `--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes
  no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.

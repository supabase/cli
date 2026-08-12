# `supabase snippets list`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are unset                             |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |

## Files Written

| Path                                           | Format | When                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                       |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/snippets?project_ref=<ref>` | Bearer token | none         | `{data: [{id, name, visibility, owner: {username}, inserted_at, updated_at, ...}], cursor?}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref`)         |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                           |
| ---- | ------------------------------------------------------------------- |
| `0`  | success                                                             |
| `1`  | `LegacySnippetsEnvNotSupportedError` — `--output env` was requested |
| `1`  | `LegacyInvalidProjectRefError` / `LegacyProjectNotLinkedError`      |
| `1`  | `LegacySnippetsListUnexpectedStatusError` — non-2xx response        |
| `1`  | `LegacySnippetsListNetworkError` — transport-level failure          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |

## Output

### `--output-format text` / `--output pretty`

Glamour-styled ASCII table with columns `ID`, `NAME`, `VISIBILITY`, `OWNER`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`. Literal `|` characters in `name`, `visibility`, or `owner.username` are passed through verbatim in the final ASCII bytes (escaped internally during markdown rendering, then decoded back).

API-supplied strings are not stripped of ANSI / terminal control sequences before rendering (inherited from the old Go CLI's glamour pass-through).

```
  ID           | NAME         | VISIBILITY | OWNER    | CREATED AT (UTC)    | UPDATED AT (UTC)
  --------------|--------------|------------|----------|---------------------|---------------------
  test-snippet | Create table | user       | supaseed | 2023-10-13 17:48:58 | 2023-10-13 17:48:58
```

### `--output json`

Indented JSON with alphabetically-sorted keys and a trailing newline. Empty `data` is rendered as `null` (not an empty array).

```json
{
  "data": [
    { "favorite": false, "id": "…", "inserted_at": "…", "name": "…", "owner": { … }, ... }
  ]
}
```

### `--output yaml`

YAML rendering of the full `V1ListAllSnippetsOutput` response.

### `--output toml`

TOML rendering of the full `V1ListAllSnippetsOutput` response, with a trailing newline.

### `--output env`

Not supported — fails with `--output env flag is not supported`.

### `--output-format json` (TS extension)

Single `success` event whose `data` is the full `V1ListAllSnippetsOutput` payload.

### `--output-format stream-json` (TS extension)

NDJSON `success` event with the full response as `data`.

## Notes

- When both `--output` and `--output-format` are set, `--output` wins (matches the precedence used elsewhere in legacy ports).
- `--output env` is rejected **after** project-ref resolution but **before** the API call.
- The linked-project cache fires after project-ref resolves; the telemetry state always flushes. Both run on success and on every error path via the two `Effect.ensuring` blocks in the handler.

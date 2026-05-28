# `supabase snippets list`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` flag and `PROJECT_ID` env are unset                                      |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |

## Files Written

| Path                                           | Format | When                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves (Go `PersistentPostRun`) |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                                                       |
| ------ | -------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/snippets?project_ref=<ref>` | Bearer token | none         | `{data: [{id, name, visibility, owner: {username}, inserted_at, updated_at, ...}], cursor?}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref`)         |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |
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

### `--output-format text` / Go `--output pretty` (Go CLI compatible)

Glamour-styled ASCII table with columns `ID`, `NAME`, `VISIBILITY`, `OWNER`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`. Pipe characters in `name` and `owner.username` are escaped as `\|` to match Go's `strings.ReplaceAll`.

```
  ID           | NAME         | VISIBILITY | OWNER    | CREATED AT (UTC)    | UPDATED AT (UTC)
  --------------|--------------|------------|----------|---------------------|---------------------
  test-snippet | Create table | user       | supaseed | 2023-10-13 17:48:58 | 2023-10-13 17:48:58
```

### Go `--output json`

Indented JSON with alphabetically-sorted keys and a trailing newline. Empty `data` is rendered as `null` to match Go's `encoding/json` nil-slice serialization.

```json
{
  "data": [
    { "favorite": false, "id": "…", "inserted_at": "…", "name": "…", "owner": { … }, ... }
  ]
}
```

### Go `--output yaml`

YAML rendering of the full `V1ListAllSnippetsOutput` response.

### Go `--output toml`

TOML rendering of the full `V1ListAllSnippetsOutput` response, with a trailing newline.

### Go `--output env`

Not supported — fails with `--output env flag is not supported`. Byte-exact match against Go's `utils.ErrEnvNotSupported` (`apps/cli-go/internal/utils/output.go:41`).

### `--output-format json` (TS extension)

Single `success` event whose `data` is the full `V1ListAllSnippetsOutput` payload.

### `--output-format stream-json` (TS extension)

NDJSON `success` event with the full response as `data`.

## Notes

- When both Go `--output` and TS `--output-format` are set, Go's flag wins (matches the precedence used elsewhere in legacy ports).
- `--output env` is rejected **after** project-ref resolution but **before** the API call, matching Go's lifecycle: cobra resolves `--project-ref` in `PersistentPreRunE`, `list.Run` checks `OutputFormat.Value` before invoking the encoder. The error message is byte-exact with `utils.ErrEnvNotSupported`.
- The linked-project cache fires after project-ref resolves (Go `PersistentPostRun`); the telemetry state always flushes (Go `Execute`). Both run on success and on every error path — the two `Effect.ensuring` blocks in the handler model the post-run order exactly.

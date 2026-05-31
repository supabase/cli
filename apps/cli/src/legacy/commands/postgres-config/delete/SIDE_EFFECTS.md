# `supabase postgres-config delete`

## Files Read

| Path                                   | Format                    | When                                                          |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                          |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (after ref resolution), via `Effect.ensuring` - on success and failure |
| `~/.supabase/telemetry.json`                     | JSON   | always, via `Effect.ensuring` - on success and failure                        |

## API Routes

| Method | Path                                          | Auth         | Request body                                                    | Response (used fields) |
| ------ | --------------------------------------------- | ------------ | --------------------------------------------------------------- | ---------------------- |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none                                                            | full JSON object       |
| `PUT`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | current config minus deleted keys (`restart_database` optional) | full JSON object       |

This command does not call a delete endpoint. It mirrors Go: fetch current config, remove the specified keys locally, then send the remaining object back via `PUT`.

## Environment Variables

| Variable                | Purpose                                              | Required?                                                 |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring -> `~/.supabase/access-token`)  |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)               |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref` -> prompt) |

## Exit Codes

| Code | Condition                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| `0`  | success - Postgres config updated with the deleted keys removed                                              |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                      |
| `1`  | initial GET non-2xx (`LegacyPostgresConfigGetUnexpectedStatusError`)                                         |
| `1`  | initial GET transport failure (`LegacyPostgresConfigGetNetworkError`)                                        |
| `1`  | PUT non-2xx (`LegacyPostgresConfigDeleteUnexpectedStatusError`)                                              |
| `1`  | PUT transport failure (`LegacyPostgresConfigDeleteNetworkError`)                                             |
| `1`  | request serialization failure (`LegacyPostgresConfigDeleteSerializeError`)                                   |
| `1`  | invalid JSON response (`LegacyPostgresConfigGetUnmarshalError` / `LegacyPostgresConfigDeleteUnmarshalError`) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                           |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` -> `<redacted>`) |

## Output

Matches `get` on success: stderr headings plus the Glamour-rendered table for the remaining config.

### `--output-format text` (default) - Go CLI compatible

Renders the remaining config map as a Glamour ASCII table.

### Go `--output pretty`

Identical to text mode.

### Go `--output json`

Go-compatible indented JSON of the remaining config object.

### Go `--output yaml`

YAML representation of the remaining config object.

### Go `--output toml`

TOML representation of the remaining config object.

### Go `--output env`

Flat `KEY="value"` lines for the remaining config object.

### `--output-format json`

Single `success` event whose data is the remaining config object.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Flags: `--config` (repeatable, config keys to delete), `--no-restart`.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- Each config key is trimmed with `strings.TrimSpace` before deletion, matching Go.
- `--no-restart` injects `restart_database = false` into the final `PUT` body.
- `linked-project.json` is written after the project ref resolves, regardless of whether the fetch or update succeeds.
- `telemetry.json` is written on every invocation, including failures.

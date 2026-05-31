# `supabase postgres-config update`

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

| Method | Path                                          | Auth         | Request body                                                  | Response (used fields) |
| ------ | --------------------------------------------- | ------------ | ------------------------------------------------------------- | ---------------------- |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none                                                          | full JSON object       |
| `PUT`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | full config object (conditional GET merge unless replace mode) | full JSON object       |

The initial `GET` is skipped when `--replace-existing-overrides` is set. Otherwise the command fetches current overrides first, merges the new values locally, then sends the final merged object back via `PUT`.

## Environment Variables

| Variable                | Purpose                                              | Required?                                                  |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring -> `~/.supabase/access-token`)  |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)                |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref` -> prompt) |

## Exit Codes

| Code | Condition                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------- |
| `0`  | success - Postgres config updated                                                                     |
| `1`  | malformed `--config` (`LegacyPostgresConfigInvalidConfigValueError`)                                 |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)             |
| `1`  | initial GET non-2xx (`LegacyPostgresConfigGetUnexpectedStatusError`)                                 |
| `1`  | initial GET transport failure (`LegacyPostgresConfigGetNetworkError`)                                |
| `1`  | PUT non-2xx (`LegacyPostgresConfigUpdateUnexpectedStatusError`)                                      |
| `1`  | PUT transport failure (`LegacyPostgresConfigUpdateNetworkError`)                                     |
| `1`  | request serialization failure (`LegacyPostgresConfigUpdateSerializeError`)                           |
| `1`  | invalid JSON response (`LegacyPostgresConfigGetUnmarshalError` / `LegacyPostgresConfigUpdateUnmarshalError`) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` -> `<redacted>`) |

## Output

Matches `get` on success: stderr headings plus the Glamour-rendered table.

### `--output-format text` (default) - Go CLI compatible

Renders the updated config map as a Glamour ASCII table.

### Go `--output pretty`

Identical to text mode.

### Go `--output json`

Go-compatible indented JSON of the updated config object.

### Go `--output yaml`

YAML representation of the updated config object.

### Go `--output toml`

TOML representation of the updated config object.

### Go `--output env`

Flat `KEY="value"` lines for the updated config object.

### `--output-format json`

Single `success` event whose data is the updated config object.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- Flags: `--config` (repeatable, parsed with the same `strings.Split(value, "=")` rule as Go), `--replace-existing-overrides`, `--no-restart`.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- Integer-like values are coerced to integers, boolean-like values are coerced to booleans, and everything else stays stringly typed before the final JSON body is serialized.
- Keys ending in `_timeout` are always stringified before the `PUT`, matching the Go timeout-normalization branch.
- `--no-restart` injects `restart_database = false` into the final request body.
- `linked-project.json` is written after the project ref resolves, regardless of whether the fetch or update succeeds.
- `telemetry.json` is written on every invocation, including failures.

# `supabase postgres-config get`

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

| Method | Path                                          | Auth         | Request body | Response (used fields) |
| ------ | --------------------------------------------- | ------------ | ------------ | ---------------------- |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none         | full JSON object       |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                 |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring -> `~/.supabase/access-token`)  |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)               |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref` -> prompt) |

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success - Postgres config printed                                                       |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`) |
| `1`  | API non-2xx (`LegacyPostgresConfigGetUnexpectedStatusError`)                            |
| `1`  | transport failure (`LegacyPostgresConfigGetNetworkError`)                               |
| `1`  | invalid JSON response (`LegacyPostgresConfigGetUnmarshalError`)                         |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                           |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` -> `<redacted>`) |

## Output

Text mode mirrors Go's pretty output path: a `- Custom Postgres Config -` heading is written to stderr, the config table is rendered to stdout, then `- End of Custom Postgres Config -` is written to stderr.

### `--output-format text` (default) - Go CLI compatible

Renders the config map as a Glamour ASCII table with `Parameter` / `Value` columns.

### Go `--output pretty`

Identical to text mode.

### Go `--output json`

Go-compatible indented JSON with alphabetical key order and a trailing newline.

### Go `--output yaml`

YAML representation of the config map.

### Go `--output toml`

TOML representation of the config map. Numeric values arrive through `json.Unmarshal` as Go `float64`, so integral numbers render with `.0` (for example `max_connections = 100.0`).

### Go `--output env`

Flat `KEY="value"` lines for each config entry.

### `--output-format json`

Single `success` event whose data is the full config object.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- The Go `--output` flag wins over the TS `--output-format` flag when both are provided.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- `linked-project.json` is written after the project ref resolves, regardless of whether the fetch succeeds.
- `telemetry.json` is written on every invocation, including failures.

# `supabase postgres-config update`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                       |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after ref resolution, via `Effect.ensuring` - on success and failure               |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` - on success and failure. Not written if the gate is closed. |

## API Routes

| Method | Path                                          | Auth         | Request body                                                   | Response (used fields) |
| ------ | --------------------------------------------- | ------------ | -------------------------------------------------------------- | ---------------------- |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none                                                           | full JSON object       |
| `PUT`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | full config object (conditional GET merge unless replace mode) | full JSON object       |

The initial `GET` is skipped when `--replace-existing-overrides` is set. Otherwise the command fetches current overrides first, merges the new values locally, then sends the final merged object back via `PUT`.

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring -> `~/.supabase/access-token`)       |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref` -> prompt)      |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success - Postgres config updated                                                                                                                                                                                                                                                                                                        |
| `1`  | malformed CSV in a `--config` value — fails during flag parsing, before the `--experimental` gate, the handler, and telemetry, with the exact diagnostic text on stderr (e.g. `invalid argument "a\"b" for "--config" flag: parse error on line 1, column 2: bare " in non-quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) - checked before ref resolution/API/telemetry                                                                                                                                                                                          |
| `1`  | malformed `--config` (`LegacyPostgresConfigInvalidConfigValueError`)                                                                                                                                                                                                                                                                     |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                                                                                                                                                                                                                  |
| `1`  | initial GET non-2xx (`LegacyPostgresConfigGetUnexpectedStatusError`)                                                                                                                                                                                                                                                                     |
| `1`  | initial GET transport failure (`LegacyPostgresConfigGetNetworkError`)                                                                                                                                                                                                                                                                    |
| `1`  | PUT non-2xx (`LegacyPostgresConfigUpdateUnexpectedStatusError`)                                                                                                                                                                                                                                                                          |
| `1`  | PUT transport failure (`LegacyPostgresConfigUpdateNetworkError`)                                                                                                                                                                                                                                                                         |
| `1`  | request serialization failure (`LegacyPostgresConfigUpdateSerializeError`)                                                                                                                                                                                                                                                               |
| `1`  | invalid JSON response (`LegacyPostgresConfigGetUnmarshalError` / `LegacyPostgresConfigUpdateUnmarshalError`)                                                                                                                                                                                                                             |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                           |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` -> `<redacted>`) |

## Output

Matches `get` on success: stderr headings plus the Glamour-rendered table.

### `--output-format text` (default)

Renders the updated config map as a Glamour ASCII table.

### `--output pretty`

Identical to text mode.

### `--output json`

Indented JSON of the updated config object.

### `--output yaml`

YAML representation of the updated config object.

### `--output toml`

TOML representation of the updated config object.

### `--output env`

Flat `KEY="value"` lines for the updated config object.

### `--output-format json`

Single `success` event whose data is the updated config object.

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- The `--output` flag wins over `--output-format` when both are provided.
- Flags: `--config` (repeatable, parsed by splitting on the first `=`), `--replace-existing-overrides`, `--no-restart`.
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- Integer-like values are coerced to integers, boolean-like values are coerced to booleans, and everything else stays stringly typed before the final JSON body is serialized.
- Keys ending in `_timeout` are always stringified before the `PUT`.
- `--no-restart` injects `restart_database = false` into the final request body.
- `linked-project.json` is written after the project ref resolves, regardless of whether the fetch or update succeeds.
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- `postgres-config` is an experimental command: `update` requires `--experimental`
  (or `SUPABASE_EXPERIMENTAL`), checked before the login check. A closed gate exits 1
  before project-ref resolution, the API calls, the `linked-project.json` write, the
  `telemetry.json` write, and the `cli_command_executed` event.

# `supabase postgres-config update`

## Files Read

| Path                                           | Format                    | When                                                                                                                 |
| ---------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                           |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write            |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves (only if every `--config` value is a `key=value` pair), on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` - on success and failure. Not written if the gate is closed.                                                                                                                                                                                                    |

## API Routes

| Method | Path                                          | Auth         | Request body                                                   | Response (used fields)                                                                                                                                                                                       |
| ------ | --------------------------------------------- | ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/projects`                                | Bearer token | none                                                           | project list for the interactive picker — only when no ref comes from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                               |
| `GET`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | none                                                           | full JSON object                                                                                                                                                                                             |
| `PUT`  | `/v1/projects/{ref}/config/database/postgres` | Bearer token | full config object (conditional GET merge unless replace mode) | full JSON object                                                                                                                                                                                             |
| `GET`  | `/v1/projects/{ref}`                          | Bearer token | none                                                           | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available |

The initial `GET` is skipped when `--replace-existing-overrides` is set. Otherwise the command fetches current overrides first, merges the new values locally, then sends the final merged object back via `PUT`.

The keys passed with `--config` (and `restart_database`) are validated locally against the API's request schema before the `PUT`, which mirrors the platform's strict validation: unknown keys and wrongly typed values fail locally and no `PUT` is sent. Stored overrides are forwarded unvalidated, so a stored key this CLI version does not know is preserved. An unknown-key failure names the key and suggests upgrading the CLI; a number given for a size or duration parameter (`work_mem=4096`) suggests passing the value with its unit (`work_mem=4096kB`). The `PUT` is sent once and never retried, since a retried `restart_database` write could restart the database twice, and its response is read as a raw JSON object so every returned key is shown.

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                                                     |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring -> `~/.supabase/access-token`)                                      |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required)                                |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success - Postgres config updated                                                                                                                                                                                                                                                                                                         |
| `1`  | malformed CSV in a `--config` value — fails during flag parsing, before the `--experimental` gate, the handler, and telemetry, with the exact diagnostic text on stderr (e.g. `invalid argument "a\"b" for "--config" flag: parse error on line 1, column 2: bare " in non-quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) - checked before ref resolution/API/telemetry                                                                                                                                                                                                 |
| `1`  | malformed `--config` (`PostgresConfigInvalidConfigValueError`)                                                                                                                                                                                                                                                                            |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError` / `InvalidProjectRefError`)                                                                                                                                                                                                                                                            |
| `1`  | initial GET non-2xx (`PostgresConfigGetUnexpectedStatusError`)                                                                                                                                                                                                                                                                            |
| `1`  | initial GET transport failure (`PostgresConfigGetNetworkError`)                                                                                                                                                                                                                                                                           |
| `1`  | PUT non-2xx (`PostgresConfigUpdateUnexpectedStatusError`)                                                                                                                                                                                                                                                                                 |
| `1`  | PUT transport failure (`PostgresConfigUpdateNetworkError`); the GET retries on 5xx and transport errors first, the PUT does not                                                                                                                                                                                                           |
| `1`  | rejected before the PUT: unknown or wrongly typed config parameter (`PostgresConfigUpdateSerializeError`, e.g. `unknown Postgres config parameter: foo (...)`, `invalid Postgres config value for work_mem: ...`)                                                                                                                         |
| `1`  | GET body is not a JSON object (`PostgresConfigGetUnmarshalError`); PUT 2xx body is not a JSON object (`PostgresConfigUpdateUnmarshalError`)                                                                                                                                                                                               |

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
- Flags: `--config` (repeatable; each value must contain exactly one `=`, otherwise `PostgresConfigInvalidConfigValueError`), `--replace-existing-overrides`, `--no-restart`.
- Requires `--project-ref`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`), or, on an interactive terminal, the project picker.
- Integer-like values are coerced to integers, boolean-like values are coerced to booleans, and everything else stays stringly typed before the final JSON body is serialized.
- Keys ending in `_timeout` are always stringified before the `PUT`.
- `--no-restart` injects `restart_database = false` into the final request body.
- `.temp/linked-project.json` is written after ref resolution (once the `--experimental` gate is open), even when the API call fails, but only on a cache miss with a token when `GET /v1/projects/{ref}` succeeds and `.temp/project-ref` does not name another ref. A closed gate writes nothing.
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- `postgres-config` is an experimental command: `update` requires `--experimental`
  (or `SUPABASE_EXPERIMENTAL`), checked before the login check. A closed gate exits 1
  before project-ref resolution, the API calls, the `linked-project.json` write, the
  `telemetry.json` write, and the `cli_command_executed` event.

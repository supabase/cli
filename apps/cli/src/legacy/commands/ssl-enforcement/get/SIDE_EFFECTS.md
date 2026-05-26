# `supabase ssl-enforcement get`

## Files Read

| Path                                   | Format                    | When                                                          |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                          |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (after ref resolution), via `Effect.ensuring` — on success and failure |
| `~/.supabase/telemetry.json`                     | JSON   | always, via `Effect.ensuring` — on success and failure                        |

## API Routes

| Method | Path                                 | Auth         | Request body | Response (used fields)                                               |
| ------ | ------------------------------------ | ------------ | ------------ | -------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/ssl-enforcement` | Bearer token | none         | `{currentConfig: {database: boolean}, appliedSuccessfully: boolean}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)  |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)              |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref` → prompt) |

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success — SSL enforcement status printed to stdout                                      |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`) |
| `1`  | API non-200 (`LegacySslEnforcementGetUnexpectedStatusError`)                            |
| `1`  | transport failure (`LegacySslEnforcementGetNetworkError`)                               |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

Matches `apps/cli-go/internal/sslenforcement/get/`. Go does not fire any custom telemetry event for this command.

## Output

### `--output-format text` (default) — Go CLI compatible

Single status line to stdout:

```
SSL is being enforced.
```

or

```
SSL is *NOT* being enforced.
```

The "_NOT_" form is emitted when `currentConfig.database` is `false` **or** when
`appliedSuccessfully` is `false` (i.e. the requested config has not yet propagated).

### Go `--output {json,yaml,toml,env}`

Byte-identical to the Go CLI's encoders (`apps/cli-go/internal/utils/output.go`).

- `json` — alphabetical struct-field order with trailing newline.
- `yaml` — `stringifyYaml(response)`.
- `toml` — `stringifyToml(response)` with trailing newline.
- `env` — Viper-flattened SCREAMING_SNAKE_CASE keys (e.g.
  `APPLIEDSUCCESSFULLY="true"\nCURRENTCONFIG_DATABASE="true"\n`).

### Go `--output pretty`

Same as `text` mode (Go's default).

### `--output-format json`

The full response object emitted as the `success` event payload:

```json
{ "currentConfig": { "database": true }, "appliedSuccessfully": true }
```

### `--output-format stream-json`

One `result` event:

```ndjson
{"type":"result","data":{"currentConfig":{"database":true},"appliedSuccessfully":true}}
```

## Notes

- The Go `--output` flag wins over the TS `--output-format` flag when both are provided.
- `linked-project.json` is written **after** the project ref is resolved, regardless of
  whether the subsequent API call succeeds (mirrors Go's `PersistentPostRun`).
- `telemetry.json` is written on every invocation, including failures.

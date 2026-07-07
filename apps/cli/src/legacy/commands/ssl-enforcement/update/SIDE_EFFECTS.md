# `supabase ssl-enforcement update`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                                   |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after the project ref is resolved (only if flag validation passes), via `Effect.ensuring`      |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — including flag-validation failures. Not written if the gate is closed. |

## API Routes

| Method | Path                                 | Auth         | Request body                             | Response (used fields)                                               |
| ------ | ------------------------------------ | ------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| `PUT`  | `/v1/projects/{ref}/ssl-enforcement` | Bearer token | `{requestedConfig: {database: boolean}}` | `{currentConfig: {database: boolean}, appliedSuccessfully: boolean}` |

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`)        |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref` → prompt)       |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — SSL enforcement status (post-update) printed to stdout                                                                                                                               |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked in `.command.ts`, before the handler (and its flag validation/telemetry) ever runs |
| `1`  | neither `--enable-db-ssl-enforcement` nor `--disable-db-ssl-enforcement` set (`LegacySslEnforcementNoEnableDisableFlagError`)                                                                  |
| `1`  | both `--enable-db-ssl-enforcement` and `--disable-db-ssl-enforcement` set (`LegacySslEnforcementMutuallyExclusiveFlagsError`)                                                                  |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                                                                        |
| `1`  | API non-200 (`LegacySslEnforcementUpdateUnexpectedStatusError`)                                                                                                                                |
| `1`  | transport failure (`LegacySslEnforcementUpdateNetworkError`)                                                                                                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`; `--enable-db-ssl-enforcement` / `--disable-db-ssl-enforcement` booleans pass through) |

Matches `apps/cli-go/internal/sslenforcement/update/`. Go does not fire any custom telemetry event for this command.

## Output

### `--output-format text` (default) — Go CLI compatible

Same status-line shape as `get` (Go's `update.Run` delegates to `get.PrintSSLStatus`):

```
SSL is being enforced.
```

or

```
SSL is *NOT* being enforced.
```

### Go `--output {json,yaml,toml,env}`

Byte-identical to the Go CLI's encoders (`apps/cli-go/internal/utils/output.go`).

### Go `--output pretty`

Same as `text` mode.

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

- `--enable-db-ssl-enforcement` and `--disable-db-ssl-enforcement` are mutually exclusive,
  enforced at handler entry (Effect CLI has no equivalent of cobra's
  `MarkFlagsMutuallyExclusive`). The Go binary uses the cobra helper directly.
- The request body always carries `database: <enableDbSslEnforcement>`; passing
  `--disable-db-ssl-enforcement` is the user-facing way to send `database: false`.
- `linked-project.json` is **not** written if flag validation fails (no ref is
  resolved). `telemetry.json` is written regardless, matching Go's
  `PersistentPostRun` semantics — but only once the `--experimental` gate is open, since
  the flag-validation/telemetry-writing handler never runs at all when the gate is closed.
- The Go `--output` flag wins over the TS `--output-format` flag when both are provided.
- `ssl-enforcement` is an experimental command (Go `root.go:63`): `update` requires
  `--experimental` (or `SUPABASE_EXPERIMENTAL`), matching Go's root-level `PersistentPreRunE`
  gate (`root.go:91-96`), which runs before the `IsManagementAPI` login check
  (`root.go:105-109`). A closed gate exits 1 before the enable/disable mutex check, project-ref
  resolution, the API call, the `linked-project.json` write, the `telemetry.json` write, and the
  `cli_command_executed` event.

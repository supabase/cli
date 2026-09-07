# `supabase network-bans get`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                       |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after ref resolution, via `Effect.ensuring` — on success and failure               |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if the gate is closed. |

## API Routes

| Method | Path                                       | Auth         | Request body | Response (used fields)    |
| ------ | ------------------------------------------ | ------------ | ------------ | ------------------------- |
| `POST` | `/v1/projects/{ref}/network-bans/retrieve` | Bearer token | none         | `{banned_ipv4_addresses}` |

The Management API exposes this read operation as `POST .../network-bans/retrieve` (not `GET`) — see `V1ListAllNetworkBans` in `packages/api/src/generated/contracts.ts`.

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`)        |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref` → prompt)       |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — network bans printed to stdout                                                                                                        |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked before ref resolution/API/telemetry |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                         |
| `1`  | API non-2xx (`LegacyNetworkBansGetUnexpectedStatusError`)                                                                                       |
| `1`  | transport failure (`LegacyNetworkBansGetNetworkError`)                                                                                          |
| `1`  | `--output env` requested (`LegacyNetworkBansEnvNotSupportedError`)                                                                              |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

## Output

A `DB banned IPs:` heading is written to stderr unconditionally before any stdout output. Exception: `--output-format json` / `--output-format stream-json` (with no `--output` flag set) emit a structured success event and skip the stderr heading to keep machine-readable output clean.

### `--output-format text` (default)

Stderr heading followed by the banned IP array rendered as JSON (alphabetical key order, two-space indent, trailing newline).

### `--output {json,pretty,yaml,toml}`

- `json` and `pretty` — JSON of the IP array (`pretty` aliases to `json`).
- `yaml` — `stringifyYaml(ipArray)`.
- `toml` — `banned_ips = ["…", "…"]\n`.

### `--output env`

Fails with `LegacyNetworkBansEnvNotSupportedError`.

### `--output-format json`

The full `V1ListAllNetworkBansOutput` response object (`{ banned_ipv4_addresses: string[] }`) emitted as the `success` event payload. Note: the `--output json` mode emits only the bare array — the TS-native `--output-format json` mode wraps it in the response object for consistency with other TS-native commands.

### `--output-format stream-json`

One `result` event whose `data` is the full response object.

## Notes

- The `--output` flag wins over `--output-format` when both are provided.
- `linked-project.json` is written **after** the project ref is resolved, regardless of whether the subsequent API call succeeds.
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- Network bans are temporary blocks on IPs with abusive traffic patterns (e.g. multiple failed auth attempts).
- `network-bans` is an experimental command: `get` requires `--experimental` (or
  `SUPABASE_EXPERIMENTAL`), checked before the login check.
  A closed gate exits 1 before project-ref resolution, the API call, the `linked-project.json`
  write, the `telemetry.json` write, and the `cli_command_executed` event.

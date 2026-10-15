# `supabase network-bans get`

## Files Read

| Path                                           | Format                    | When                                                                                                                 |
| ---------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                           |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write            |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if the gate is closed.                                                                                                                                             |

## API Routes

| Method | Path                                       | Auth         | Request body | Response (used fields)                                                                                                                                                                                       |
| ------ | ------------------------------------------ | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/projects`                             | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                               |
| `POST` | `/v1/projects/{ref}/network-bans/retrieve` | Bearer token | none         | `{banned_ipv4_addresses}`                                                                                                                                                                                    |
| `GET`  | `/v1/projects/{ref}`                       | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available |

The Management API exposes this read operation as `POST .../network-bans/retrieve` (not `GET`) — see `V1ListAllNetworkBans` in `packages/api/src/generated/contracts.ts`.

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                                                     |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`)                                       |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required)                                |

## Exit Codes

| Code | Condition                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — network bans printed to stdout                                                                                                  |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) — checked before ref resolution/API/telemetry |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError` / `InvalidProjectRefError`)                                                            |
| `1`  | API non-2xx (`NetworkBansGetUnexpectedStatusError`)                                                                                       |
| `1`  | transport failure (`NetworkBansGetNetworkError`)                                                                                          |
| `1`  | `--output env` requested (`NetworkBansEnvNotSupportedError`)                                                                              |

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

Fails with `NetworkBansEnvNotSupportedError`.

### `--output-format json`

The full `V1ListAllNetworkBansOutput` response object (`{ banned_ipv4_addresses: string[] }`) emitted as the `success` event payload. Note: the `--output json` mode emits only the bare array — the TS-native `--output-format json` mode wraps it in the response object for consistency with other TS-native commands.

### `--output-format stream-json`

One `result` event whose `data` is the full response object.

## Notes

- The `--output` flag wins over `--output-format` when both are provided.
- `.temp/linked-project.json` is written after ref resolution (once the `--experimental` gate is open), even when the API call fails, but only on a cache miss with a token when `GET /v1/projects/{ref}` succeeds and `.temp/project-ref` does not name another ref. A closed gate writes nothing.
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- Network bans are temporary blocks on IPs with abusive traffic patterns (e.g. multiple failed auth attempts).
- `network-bans` is an experimental command: `get` requires `--experimental` (or
  `SUPABASE_EXPERIMENTAL`), checked before the login check.
  A closed gate exits 1 before project-ref resolution, the API call, the `linked-project.json`
  write, the `telemetry.json` write, and the `cli_command_executed` event.

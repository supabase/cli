# `supabase network-bans get`

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

| Method | Path                                       | Auth         | Request body | Response (used fields)    |
| ------ | ------------------------------------------ | ------------ | ------------ | ------------------------- |
| `POST` | `/v1/projects/{ref}/network-bans/retrieve` | Bearer token | none         | `{banned_ipv4_addresses}` |

The Management API exposes this read operation as `POST .../network-bans/retrieve` (not `GET`) — see `V1ListAllNetworkBans` in `packages/api/src/generated/contracts.ts`.

## Environment Variables

| Variable                | Purpose                                              | Required?                                                |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)  |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)              |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref` → prompt) |

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success — network bans printed to stdout                                                |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`) |
| `1`  | API non-2xx (`LegacyNetworkBansGetUnexpectedStatusError`)                               |
| `1`  | transport failure (`LegacyNetworkBansGetNetworkError`)                                  |
| `1`  | `--output env` requested (`LegacyNetworkBansEnvNotSupportedError`)                      |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

Matches `apps/cli-go/internal/bans/get/`. Go does not fire any custom telemetry event for this command.

## Output

A `DB banned IPs:` heading is written to stderr unconditionally before any stdout output (mirrors Go's `fmt.Fprintln(os.Stderr, "DB banned IPs:")`). Exception: `--output-format json` / `--output-format stream-json` (with no Go `--output` flag set) emit a structured success event and skip the stderr heading to keep machine-readable output clean.

### `--output-format text` (default) — Go CLI compatible

Stderr heading followed by the banned IP array rendered as Go-compatible JSON (alphabetical key order, two-space indent, trailing newline).

### Go `--output {json,pretty,yaml,toml}`

Byte-identical to the Go CLI's encoders.

- `json` and `pretty` — Go-compatible JSON of the IP array (`pretty` aliases to `json` per `apps/cli-go/internal/bans/get/get.go:21-23`).
- `yaml` — `stringifyYaml(ipArray)`.
- `toml` — `banned_ips = ["…", "…"]\n` (matches the Go struct tag `toml:"banned_ips"`).

### Go `--output env`

Fails with `LegacyNetworkBansEnvNotSupportedError`, matching Go's `utils.ErrEnvNotSupported`.

### `--output-format json`

The full `V1ListAllNetworkBansOutput` response object (`{ banned_ipv4_addresses: string[] }`) emitted as the `success` event payload. Note: the Go `--output json` mode emits only the bare array — the TS-native `--output-format json` mode wraps it in the response object for consistency with other TS-native commands.

### `--output-format stream-json`

One `result` event whose `data` is the full response object.

## Notes

- The Go `--output` flag wins over the TS `--output-format` flag when both are provided.
- `linked-project.json` is written **after** the project ref is resolved, regardless of whether the subsequent API call succeeds (mirrors Go's `PersistentPostRun`).
- `telemetry.json` is written on every invocation, including failures.
- Network bans are temporary blocks on IPs with abusive traffic patterns (e.g. multiple failed auth attempts).

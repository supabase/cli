# `supabase network-bans remove`

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

| Method   | Path                              | Auth         | Request body                                        | Response (used fields) |
| -------- | --------------------------------- | ------------ | --------------------------------------------------- | ---------------------- |
| `DELETE` | `/v1/projects/{ref}/network-bans` | Bearer token | `{ipv4_addresses: string[], requester_ip: boolean}` | none                   |

`requester_ip` is `true` when no `--db-unban-ip` flags are passed (self-unban mode) and `false` otherwise — matching Go's `len(addrs) == 0` derivation in `apps/cli-go/internal/utils/flags/db_url.go:UnbanIP`.

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
| `0`  | success — network ban removed                                                                                                                   |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked before ref resolution/API/telemetry |
| `1`  | invalid IP supplied via `--db-unban-ip` (`LegacyNetworkBansInvalidIpError`)                                                                     |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                         |
| `1`  | API non-2xx (`LegacyNetworkBansRemoveUnexpectedStatusError`)                                                                                    |
| `1`  | transport failure (`LegacyNetworkBansRemoveNetworkError`)                                                                                       |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                          |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`, `--db-unban-ip` → `<redacted>`) |

Matches `apps/cli-go/internal/bans/update/`. Go does not fire any custom telemetry event for this command.

## Output

Matches Go's `PostRun` hook — `Successfully removed network bans.\n` is always written to stdout regardless of the legacy `--output` flag (Go's `update.Run` does not read `OutputFormat`).

### `--output-format text` (default) — Go CLI compatible

Prints `Successfully removed network bans.\n` to stdout.

### Go `--output {json,pretty,yaml,toml,env}`

Identical to text mode — Go's `update.Run` ignores `--output` and `PostRun` always prints the success line.

### `--output-format json`

Single `success` event emitted to stdout when the Go `--output` flag is unset. When Go `--output` is set, the raw text line is emitted instead (Go priority).

### `--output-format stream-json`

One `result` event on success when the Go `--output` flag is unset.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- The Go `--output` flag wins over the TS `--output-format` flag when both are provided.
- Requires `--db-unban-ip` flag to specify IP(s) to unban (repeatable). When omitted, the caller's own IP is unbanned (`requester_ip: true`).
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- `linked-project.json` is written **after** the project ref is resolved, regardless of whether the subsequent API call succeeds (mirrors Go's `PersistentPostRun`).
- `telemetry.json` is written on every invocation, including failures, but only once the `--experimental` gate is open.
- `network-bans` is an experimental command (Go `root.go:63`, `bansCmd`): `remove` requires
  `--experimental` (or `SUPABASE_EXPERIMENTAL`), matching Go's root-level `PersistentPreRunE`
  gate (`root.go:91-96`), which runs before the `IsManagementAPI` login check (`root.go:105-109`).
  A closed gate exits 1 before project-ref resolution, the API call, the `linked-project.json`
  write, the `telemetry.json` write, and the `cli_command_executed` event.

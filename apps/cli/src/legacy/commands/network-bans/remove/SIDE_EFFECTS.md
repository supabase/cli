# `supabase network-bans remove`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                                                                                |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after ref resolution, via `Effect.ensuring` — on success and failure                                                                        |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if the gate is closed or if flag parsing fails (malformed `--db-unban-ip` CSV). |

## API Routes

| Method   | Path                              | Auth         | Request body                                        | Response (used fields) |
| -------- | --------------------------------- | ------------ | --------------------------------------------------- | ---------------------- |
| `DELETE` | `/v1/projects/{ref}/network-bans` | Bearer token | `{ipv4_addresses: string[], requester_ip: boolean}` | none                   |

`requester_ip` is `true` when no `--db-unban-ip` flags are passed (self-unban mode) and `false` otherwise.

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`)        |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref` → prompt)       |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — network ban removed                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `1`  | malformed CSV in a `--db-unban-ip` value, e.g. unterminated quote — stderr reproduces the fixed diagnostic text (`invalid argument "\"1.2.3.4" for "--db-unban-ip" flag: parse error on line 1, column 9: extraneous or missing " in quoted-field`; columns are 1-based byte offsets) — fails during flag parsing, before the `--experimental` gate, the handler, the `linked-project.json`/`telemetry.json` writes, and the `cli_command_executed` event |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked before ref resolution/API/telemetry                                                                                                                                                                                                                                                                                                                             |
| `1`  | invalid IP supplied via `--db-unban-ip` (`LegacyNetworkBansInvalidIpError`)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                                                                                                                                                                                                                                                                                                                                                     |
| `1`  | API non-2xx (`LegacyNetworkBansRemoveUnexpectedStatusError`)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `1`  | transport failure (`LegacyNetworkBansRemoveNetworkError`)                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                          |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`, `--db-unban-ip` → `<redacted>`) |

## Output

`Successfully removed network bans.\n` is always written to stdout regardless of the `--output` flag.

### `--output-format text` (default)

Prints `Successfully removed network bans.\n` to stdout.

### `--output {json,pretty,yaml,toml,env}`

Identical to text mode — this command ignores `--output` and always prints the success line.

### `--output-format json`

Single `success` event emitted to stdout when the `--output` flag is unset. When `--output` is set, the raw text line is emitted instead.

### `--output-format stream-json`

One `result` event on success when the `--output` flag is unset.

```ndjson
{"type":"result","data":{...}}
```

## Notes

- The `--output` flag wins over `--output-format` when both are provided.
- Requires `--db-unban-ip` flag to specify IP(s) to unban (repeatable). When omitted, the caller's own IP is unbanned (`requester_ip: true`).
- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- `linked-project.json` is written **after** the project ref is resolved, regardless of whether the subsequent API call succeeds.
- `telemetry.json` is written on every invocation that reaches the handler, including failures, but only once the `--experimental` gate is open. A malformed `--db-unban-ip` CSV value (e.g. an unterminated quote) fails during flag parsing — before the gate, the handler, both file writes, and the `cli_command_executed` event — even when `--experimental` is passed.
- `network-bans` is an experimental command: `remove` requires `--experimental` (or
  `SUPABASE_EXPERIMENTAL`), checked before the login check.
  A closed gate exits 1 before project-ref resolution, the API call, the `linked-project.json`
  write, the `telemetry.json` write, and the `cli_command_executed` event.

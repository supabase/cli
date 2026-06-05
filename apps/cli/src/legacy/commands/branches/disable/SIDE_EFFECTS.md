# `supabase branches disable`

Hidden subcommand (`Hidden: true` in Go). Operates on the entire linked project rather than a single branch.

## Files Read

Same auth and project-ref resolution chain as every Management-API legacy command.

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

## API Routes

| Method   | Path                          | Auth         | Request body | Response          |
| -------- | ----------------------------- | ------------ | ------------ | ----------------- |
| `DELETE` | `/v1/projects/{ref}/branches` | Bearer token | none         | none (expect 200) |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list`.

## Exit Codes

| Code | Condition                                                                                 |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | success — preview branching disabled for the project                                      |
| `1`  | `LegacyBranchesDisableUnexpectedStatusError` — non-200 response from the disable endpoint |
| `1`  | `LegacyBranchesDisableNetworkError` — transport-level network failure                     |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` (Go CLI compatible)

`Disabled preview branching for project: <ref>` written to **stdout** (Go `fmt.Println`).

### `--output-format json` / `stream-json`

Single `success` event carrying `{project_ref}`.

# `supabase branches unpause`

## Files Read

Same auth and project-ref resolution chain as every Management-API legacy command.

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

## API Routes

| Method | Path                                 | Auth         | When                                                           | Response          |
| ------ | ------------------------------------ | ------------ | -------------------------------------------------------------- | ----------------- |
| `GET`  | `/v1/projects/{ref}/branches/{name}` | Bearer token | branch input is not a UUID and not a `^[a-z]{20}$` ref pattern | `{project_ref}`   |
| `GET`  | `/v1/branches/{branch_id_or_ref}`    | Bearer token | branch input is a UUID                                         | `{ref}`           |
| `POST` | `/v1/projects/{branch_ref}/restore`  | Bearer token | always — final unpause action                                  | none (expect 200) |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list`.

## Exit Codes

| Code | Condition                                                                             |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | success — branch unpaused                                                             |
| `1`  | `LegacyBranchesUnpauseUnexpectedStatusError` — non-200 response from restore endpoint |
| `1`  | `LegacyBranchesUnpauseNetworkError` — transport-level network failure                 |
| `1`  | Branch-id resolution errors                                                           |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

Silent on success in every mode (Go parity).

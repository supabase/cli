# `supabase branches pause`

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
| `POST` | `/v1/projects/{branch_ref}/pause`    | Bearer token | always — final pause action                                    | none (expect 200) |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list`.

## Exit Codes

| Code | Condition                                                                         |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | success — branch paused                                                           |
| `1`  | `LegacyBranchesPauseUnexpectedStatusError` — non-200 response from pause endpoint |
| `1`  | `LegacyBranchesPauseNetworkError` — transport-level network failure               |
| `1`  | Branch-id resolution errors (find / config endpoints failed)                      |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

Silent on success in every mode (Go parity — no stdout / stderr emission inside the handler). The prompt helper may write `Selected branch ID: <ref>` to stderr in text mode if the TTY picker was used.

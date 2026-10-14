# `supabase branches unpause`

## Files Read

Same auth fallback chain as every Management-API command. Project-ref discovery (for the PARENT) is PARENT-scoped (CLI-2167 follow-up, TS-only): env `SUPABASE_PROJECT_ID` → `<workdir>/supabase/.temp/linked-project.json`'s `ref` → `<workdir>/supabase/.temp/project-ref`, first ref-shaped candidate wins — see `branches list/SIDE_EFFECTS.md` for the full chain and rationale.

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | after the command runs (in `Effect.ensuring`), unless the file already exists, `.temp/project-ref` names a different project, no access token resolves, or the project lookup is not 200 |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                          |

## API Routes

| Method | Path                                 | Auth         | When                                                                                                                                                        | Response                                          |
| ------ | ------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/branches/{name}` | Bearer token | branch input is not a UUID and not a `^[a-z]{20}$` ref pattern                                                                                              | `{project_ref}`                                   |
| `GET`  | `/v1/branches/{branch_id_or_ref}`    | Bearer token | branch input is a UUID                                                                                                                                      | `{ref}`                                           |
| `POST` | `/v1/projects/{branch_ref}/restore`  | Bearer token | always — final unpause action                                                                                                                               | none (expect 200)                                 |
| `GET`  | `/v1/projects/{ref}/branches`        | Bearer token | branch argument omitted or empty and stdin is a TTY (branch picker)                                                                                         | `[{name, project_ref, …}]`                        |
| `GET`  | `/v1/projects`                       | Bearer token | no project ref from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format (project picker) | `[{id, name, organization_slug, region, …}]`      |
| `GET`  | `/v1/projects/{ref}`                 | Bearer token | linked-project cache miss only (best-effort, after the command)                                                                                             | `{ref, name, organization_id, organization_slug}` |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list` (including the CLI-2167 PARENT-scoped resolution chain).

## Exit Codes

| Code | Condition                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | success — branch unpaused                                                       |
| `1`  | `BranchesUnpauseUnexpectedStatusError` — non-200 response from restore endpoint |
| `1`  | `BranchesUnpauseNetworkError` — transport-level network failure                 |
| `1`  | Branch-id resolution errors                                                     |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

Silent on success in every mode.

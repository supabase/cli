# `supabase branches delete`

Target: hosted, consent default No — see [Command target](../../../../docs/command-target.md)

## Files Read

Same auth fallback chain as every Management-API command. Project-ref discovery (for the PARENT) is PARENT-scoped (CLI-2167 follow-up): env `SUPABASE_PROJECT_ID` → `<workdir>/supabase/.temp/linked-project.json`'s `ref` → `<workdir>/supabase/.temp/project-ref`, first ref-shaped candidate wins — see `branches list/SIDE_EFFECTS.md` for the full chain and rationale.

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | after the command runs (in `Effect.ensuring`), unless the file already exists, `.temp/project-ref` names a different project, no access token resolves, or the project lookup is not 200 |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                          |

## API Routes

| Method   | Path                                 | Auth         | When                                                                                                                                                         | Response                                          |
| -------- | ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `GET`    | `/v1/projects/{ref}/branches/{name}` | Bearer token | branch input is not a UUID and not a `^[a-z]{20}$` ref pattern                                                                                               | `{project_ref}`                                   |
| `GET`    | `/v1/branches/{branch_id_or_ref}`    | Bearer token | branch input is a UUID                                                                                                                                       | `{ref}`                                           |
| `DELETE` | `/v1/branches/{branch_id_or_ref}`    | Bearer token | always — `force` query param omitted                                                                                                                         | `{ message: "ok" }`                               |
| `GET`    | `/v1/projects/{ref}/branches`        | Bearer token | branch argument omitted or empty and stdin is a TTY (branch picker)                                                                                          | `[{name, project_ref, …}]`                        |
| `GET`    | `/v1/projects`                       | Bearer token | no project ref from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format (project picker) | `[{id, name, organization_slug, region, …}]`      |
| `GET`    | `/v1/projects/{ref}`                 | Bearer token | linked-project cache miss only (best-effort, after the command)                                                                                              | `{ref, name, organization_id, organization_slug}` |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list` (including the CLI-2167 PARENT-scoped resolution chain).

`SUPABASE_YES` — approves the hosted-mutation confirmation like `--yes`; read from the shell environment only, never `supabase/.env`.

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — branch deleted                                                                                               |
| `1`  | `BranchesDeleteUnexpectedStatusError` — non-200 response from delete endpoint                                          |
| `1`  | `BranchesDeleteNetworkError` — transport-level network failure                                                         |
| `1`  | Branch-id resolution errors                                                                                            |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

`Deleted preview branch: <ref>` written to **stderr**.

### `--output-format json` / `stream-json`

Single `success` event carrying `{project_ref}`.

## Notes

- `--remote=<ref>` names the parent project; with no selector or a bare `--remote` the parent comes from the chain above. A branch name or UUID is rejected with `` `supabase branches delete` acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>. `` The branch itself stays a positional argument.
- **Consent.** Asks once, after the branch name or ID is resolved to its ref and before the API write, with default No: `Delete preview branch <name-or-id>`. The question also shows the branch project ref.

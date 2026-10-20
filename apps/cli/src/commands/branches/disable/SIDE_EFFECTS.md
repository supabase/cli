# `supabase branches disable`

Target: hosted, consent default No — see [Command target](../../../../docs/command-target.md)

Hidden subcommand. Operates on the entire linked project rather than a single branch.

## Files Read

Same auth fallback chain as every Management-API command. Project-ref discovery (for the PARENT) is PARENT-scoped (CLI-2167 follow-up): env `SUPABASE_PROJECT_ID` → `<workdir>/supabase/.temp/linked-project.json`'s `ref` → `<workdir>/supabase/.temp/project-ref`, first ref-shaped candidate wins — see `branches list/SIDE_EFFECTS.md` for the full chain and rationale.

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | after the command runs (in `Effect.ensuring`), unless the file already exists, `.temp/project-ref` names a different project, no access token resolves, or the project lookup is not 200 |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                          |

## API Routes

| Method   | Path                          | Auth         | Request body | Response                                                                                                                                                                                                    |
| -------- | ----------------------------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE` | `/v1/projects/{ref}/branches` | Bearer token | none         | none (expect 200)                                                                                                                                                                                           |
| `GET`    | `/v1/projects`                | Bearer token | none         | `[{id, name, organization_slug, region, …}]` — no project ref from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format (project picker) |
| `GET`    | `/v1/projects/{ref}`          | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, after the command)                                                                                         |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list` (including the CLI-2167 PARENT-scoped resolution chain).

`SUPABASE_YES` — approves the hosted-mutation confirmation like `--yes`; read from the shell environment only, never `supabase/.env`.

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — preview branching disabled for the project                                                                   |
| `1`  | `BranchesDisableUnexpectedStatusError` — non-200 response from the disable endpoint                                    |
| `1`  | `BranchesDisableNetworkError` — transport-level network failure                                                        |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

`Disabled preview branching for project: <ref>` written to **stdout**.

### `--output-format json` / `stream-json`

Single `success` event carrying `{project_ref}`.

## Notes

- `--remote=<ref>` names the parent project; with no selector or a bare `--remote` the parent comes from the chain above. A branch name or UUID is rejected with `` `supabase branches disable` acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>. `` The branch itself stays a positional argument.
- **Consent.** Asks once, after the parent project is resolved and before the DELETE, with default No: `Disable preview branching`.

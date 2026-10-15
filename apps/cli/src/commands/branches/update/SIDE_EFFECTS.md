# `supabase branches update`

## Files Read

Same auth fallback chain as every Management-API command. Project-ref discovery (for the PARENT) is PARENT-scoped (CLI-2167 follow-up): env `SUPABASE_PROJECT_ID` → `<workdir>/supabase/.temp/linked-project.json`'s `ref` → `<workdir>/supabase/.temp/project-ref`, first ref-shaped candidate wins — see `branches list/SIDE_EFFECTS.md` for the full chain and rationale.

## Files Written

| Path                                           | Format | When                                                         |
| ---------------------------------------------- | ------ | ------------------------------------------------------------ |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method  | Path                                            | Auth         | When                                                           | Request body                                                                              | Response                             |
| ------- | ----------------------------------------------- | ------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET`   | `/v1/projects/{ref}/branches/{name}`            | Bearer token | branch input is not a UUID and not a `^[a-z]{20}$` ref pattern | none                                                                                      | `{project_ref}`                      |
| `GET`   | `/v1/branches/{branch_id_or_ref}`               | Bearer token | branch input is a UUID                                         | none                                                                                      | `{ref}`                              |
| `PATCH` | `/v1/branches/{branch_id_or_ref}`               | Bearer token | always                                                         | `{branch_name?, git_branch?, persistent?, status?, notify_url?}` (only set flags emitted) | full `BranchResponse`                |
| `GET`   | `/v1/projects/{ref}` (on 4xx gated)             | Bearer token | upgrade-suggest path                                           | none                                                                                      | `{organization_slug}`                |
| `GET`   | `/v1/organizations/{slug}/entitlements` (gated) | Bearer token | upgrade-suggest path                                           | none                                                                                      | `[{feature: {key}, hasAccess, ...}]` |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list` (including the CLI-2167 PARENT-scoped resolution chain).

`SUPABASE_YES` — approves the hosted-mutation confirmation like `--yes`; read from the shell environment only, never `supabase/.env`.

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — branch updated                                                                                               |
| `1`  | `BranchesUpdateUnexpectedStatusError` — non-200 response from the update endpoint                                      |
| `1`  | `BranchesUpdateNetworkError` — transport-level network failure                                                         |
| `1`  | Branch-id resolution errors (find / config endpoints failed)                                                           |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags`               |
| `cli_upgrade_suggested` | on 4xx with `branching_persistent` entitlement gated | `{feature_key: "branching_persistent", org_slug}` |

## Output

Honors both `--output {pretty,json,yaml,toml,env}` and `--output-format {text,json,stream-json}`.

In **text mode**, the header `Updated preview branch:` writes to **stderr** followed by the single-row list-table on stdout.

For `--output {json,yaml,toml,env}`, the header goes to stderr followed by the encoded payload on stdout. In `--output-format json` / `stream-json`, a `success` event carries the payload.

## Notes

- The upgrade-suggest call uses the branch's own resolved project ref (`resolveBranchProjectRef`) — not the parent `--project-ref` value — so the entitlements check is scoped to the branch's org.
- Resolves the parent project and prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged.
- **Consent.** Asks once, after the branch name or ID is resolved to its ref and before the PATCH, with default No: `Update preview branch <name-or-id>`. The question also shows the branch project ref and each change that was requested (`--name`, `--git-branch`, `--persistent`, `--status`, `--notify-url`). `--yes` or a shell `SUPABASE_YES` approves it (`supabase/.env` does not) and echoes `Confirmed by --yes: <action> on <target>` to stderr. Without it, only an interactive text-mode terminal is asked: JSON, `-o`, piped and agent runs exit 1 with `HostedMutationConsentRequiredError` and change nothing, and declining exits 1 with `HostedMutationDeclinedError`. Stdin is never read.

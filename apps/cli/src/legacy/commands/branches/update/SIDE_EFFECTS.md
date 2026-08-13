# `supabase branches update`

## Files Read

Same auth fallback chain as every Management-API legacy command. Project-ref discovery (for the PARENT) is PARENT-scoped (CLI-2167 follow-up, TS-only): env `SUPABASE_PROJECT_ID` → `<workdir>/supabase/.temp/linked-project.json`'s `ref` → `<workdir>/supabase/.temp/project-ref`, first ref-shaped candidate wins — see `branches list/SIDE_EFFECTS.md` for the full chain and rationale.

## Files Written

| Path                                           | Format | When                                                                     |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

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

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success — branch updated                                                                |
| `1`  | `LegacyBranchesUpdateUnexpectedStatusError` — non-200 response from the update endpoint |
| `1`  | `LegacyBranchesUpdateNetworkError` — transport-level network failure                    |
| `1`  | Branch-id resolution errors (find / config endpoints failed)                            |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags`               |
| `cli_upgrade_suggested` | on 4xx with `branching_persistent` entitlement gated | `{feature_key: "branching_persistent", org_slug}` |

## Output

Honors both `--output {pretty,json,yaml,toml,env}` (Go) and `--output-format {text,json,stream-json}` (TS).

In **text mode**, the header `Updated preview branch:` writes to **stderr** (Go `fmt.Fprintln(os.Stderr, …)`) followed by the single-row Glamour list-table on stdout.

In Go encoder modes, the header goes to stderr followed by the encoded payload on stdout. In `--output-format json` / `stream-json`, a `success` event carries the payload.

## Notes

The upgrade-suggest call uses the branch's own resolved project ref (`legacyResolveBranchProjectRef`), matching Go's `update.go:26` (`pause.GetBranchProjectRef`) — not the parent `--project-ref` value — so the entitlements check is scoped to the branch's org.

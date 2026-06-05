# `supabase branches update`

## Files Read

Same auth and project-ref resolution chain as every Management-API legacy command.

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

## API Routes

| Method  | Path                                            | Auth         | When                                                           | Request body                                                                              | Response                             |
| ------- | ----------------------------------------------- | ------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET`   | `/v1/projects/{ref}/branches/{name}`            | Bearer token | branch input is not a UUID and not a `^[a-z]{20}$` ref pattern | none                                                                                      | `{project_ref}`                      |
| `GET`   | `/v1/branches/{branch_id_or_ref}`               | Bearer token | branch input is a UUID                                         | none                                                                                      | `{ref}`                              |
| `PATCH` | `/v1/branches/{branch_id_or_ref}`               | Bearer token | always                                                         | `{branch_name?, git_branch?, persistent?, status?, notify_url?}` (only set flags emitted) | full `BranchResponse`                |
| `GET`   | `/v1/projects/{ref}` (on 4xx gated)             | Bearer token | upgrade-suggest path                                           | none                                                                                      | `{organization_slug}`                |
| `GET`   | `/v1/organizations/{slug}/entitlements` (gated) | Bearer token | upgrade-suggest path                                           | none                                                                                      | `[{feature: {key}, hasAccess, ...}]` |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list`.

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

The upgrade-suggest call uses the parent project ref (resolved from `--project-ref`) rather than the branch's project ref. Both refs belong to the same organization, so the entitlement check returns the same `org_slug` either way; this also sidesteps a known API schema constraint where `getProject` strictly requires a `^[a-z]{20}$` ref.

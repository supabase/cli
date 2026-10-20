# `supabase branches create`

Target: hosted, consent default Yes — see [Command target](../../../../docs/command-target.md)

## Files Read

| Path                                           | Format                    | When                                                                                                                           |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                                  |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                                       |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                                                  |
| `<workdir>/supabase/.temp/linked-project.json` | JSON (`ref` field)        | when `--remote=<ref>` is not given, as the 2nd PARENT-ref candidate (CLI-2167 follow-up — see `branches list/SIDE_EFFECTS.md`) |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set, as the 3rd (last) PARENT-ref candidate                         |
| `<cwd>/.git/HEAD` (walking parents)            | plain text                | when the positional `[name]` arg is omitted — fallback branch name detection                                                   |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | after the command runs (in `Effect.ensuring`), unless the file already exists, `.temp/project-ref` names a different project, no access token resolves, or the project lookup is not 200 |
| `~/.supabase/telemetry.json`                   | JSON   | always (in `Effect.ensuring`) at end of command                                                                                                                                          |

## API Routes

| Method | Path                                            | Auth         | Request body                                                                                                           | Response (used fields)                                                                                                                                                                                      |
| ------ | ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/projects/{ref}/branches`                   | Bearer token | `{branch_name, is_default: false, git_branch?, region?, desired_instance_size?, persistent?, with_data?, notify_url?}` | full `BranchResponse`                                                                                                                                                                                       |
| `GET`  | `/v1/projects/{ref}` (on 4xx gated)             | Bearer token | none                                                                                                                   | `{organization_slug}`                                                                                                                                                                                       |
| `GET`  | `/v1/organizations/{slug}/entitlements` (gated) | Bearer token | none                                                                                                                   | `[{feature: {key}, hasAccess, ...}]`                                                                                                                                                                        |
| `GET`  | `/v1/projects`                                  | Bearer token | none                                                                                                                   | `[{id, name, organization_slug, region, …}]` — no project ref from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format (project picker) |
| `GET`  | `/v1/projects/{ref}`                            | Bearer token | none                                                                                                                   | `{ref, name, organization_id, organization_slug}` — linked-project cache miss only (best-effort, after the command)                                                                                         |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                 | Required?                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                    | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | selects API base URL (`supabase` / `supabase-staging` / `supabase-local`) or a YAML profile path                                                                        | no                                                      |
| `SUPABASE_PROJECT_ID`   | PARENT project ref fallback (1st candidate) when `--remote=<ref>` is not given (CLI-2167 follow-up) — see `branches list/SIDE_EFFECTS.md` for the full resolution chain | no                                                      |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                       | no                                                      |
| `GITHUB_HEAD_REF`       | preferred over walking `.git/HEAD` when detecting the default branch name in CI                                                                                         | no                                                      |
| `SUPABASE_YES`          | approves the hosted-mutation confirmation like `--yes` (shell environment only; `supabase/.env` is ignored)                                                             | no                                                      |

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — branch created                                                                                               |
| `1`  | `BranchesCreateUnexpectedStatusError` — non-201 response from the create branch endpoint                               |
| `1`  | `BranchesCreateNetworkError` — transport-level network failure                                                         |
| `1`  | Auth / project-ref resolution errors (`AccessTokenRequiredError`, …)                                                   |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                   | When                                            | Notable properties / groups                                                                                                                                   |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)      | `exit_code`, `duration_ms`, `flags` (`--remote=<ref>` → the ref, a bare `--remote` → `true`; `--project-ref` whitelisted when ref-shaped, otherwise redacted) |
| `cli_upgrade_suggested` | on 4xx with `branching_limit` entitlement gated | `{feature_key: "branching_limit", org_slug}`                                                                                                                  |

## Output

Honors both `--output {pretty,json,yaml,toml,env}` and `--output-format {text,json,stream-json}`. `--output` wins when both are supplied.

In **text mode** (default / `--output pretty`), the header `Created preview branch:` writes to **stdout** followed by the single-row styled list-table.

For `--output {json,yaml,toml,env}`, the same header writes to stdout followed by the encoded `V1CreateABranchOutput` payload.

In `--output-format json` / `stream-json`, a `success` event carries the response payload.

## Notes

- `--remote=<ref>` names the parent project; with no selector or a bare `--remote` the parent comes from the chain above. A branch name or UUID is rejected with `` `supabase branches create` acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>. `` The branch itself stays a positional argument.
- **Consent.** Asks once, after the parent project is resolved and the name is known (taken from the current git branch when `[name]` is omitted) and before the POST, with default Yes: `Create preview branch <name>`. The question lists the region, size, persistence and `--with-data` values that were set, and says when the name came from the git branch. The separate git-branch confirmation prompt is gone.

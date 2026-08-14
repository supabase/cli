# `supabase branches create`

## Files Read

| Path                                           | Format                    | When                                                                                                                               |
| ---------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile`                                      |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                                           |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                                                      |
| `<workdir>/supabase/.temp/linked-project.json` | JSON (`ref` field)        | when `--project-ref` is unset, as the 2nd PARENT-ref candidate (CLI-2167 follow-up, TS-only — see `branches list/SIDE_EFFECTS.md`) |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset, as the 3rd (last) PARENT-ref candidate                              |
| `<cwd>/.git/HEAD` (walking parents)            | plain text                | when the positional `[name]` arg is omitted — fallback branch name detection                                                       |

## Files Written

| Path                                             | Format | When                                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method | Path                                            | Auth         | Request body                                                                                                           | Response (used fields)               |
| ------ | ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `POST` | `/v1/projects/{ref}/branches`                   | Bearer token | `{branch_name, is_default: false, git_branch?, region?, desired_instance_size?, persistent?, with_data?, notify_url?}` | full `BranchResponse`                |
| `GET`  | `/v1/projects/{ref}` (on 4xx gated)             | Bearer token | none                                                                                                                   | `{organization_slug}`                |
| `GET`  | `/v1/organizations/{slug}/entitlements` (gated) | Bearer token | none                                                                                                                   | `[{feature: {key}, hasAccess, ...}]` |

## Environment Variables

| Variable                | Purpose                                                                                                                                                            | Required?                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                               | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | selects API base URL (`supabase` / `supabase-staging` / `supabase-local`) or a YAML profile path                                                                   | no                                                      |
| `SUPABASE_PROJECT_ID`   | PARENT project ref fallback (1st candidate) when `--project-ref` is unset (CLI-2167 follow-up) — see `branches list/SIDE_EFFECTS.md` for the full resolution chain | no                                                      |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                  | no                                                      |
| `GITHUB_HEAD_REF`       | preferred over walking `.git/HEAD` when detecting the default branch name in CI                                                                                    | no                                                      |

## Exit Codes

| Code | Condition                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | success — branch created                                                                       |
| `1`  | `LegacyBranchesCreateCancelledError` — user declined the git-branch confirmation prompt        |
| `1`  | `LegacyBranchesCreateUnexpectedStatusError` — non-201 response from the create branch endpoint |
| `1`  | `LegacyBranchesCreateNetworkError` — transport-level network failure                           |
| `1`  | Auth / project-ref resolution errors (`LegacyPlatformAuthRequiredError`, …)                    |

## Telemetry Events Fired

| Event                   | When                                            | Notable properties / groups                                       |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)      | `exit_code`, `duration_ms`, `flags` (`--project-ref` whitelisted) |
| `cli_upgrade_suggested` | on 4xx with `branching_limit` entitlement gated | `{feature_key: "branching_limit", org_slug}`                      |

## Output

Honors both `--output {pretty,json,yaml,toml,env}` and `--output-format {text,json,stream-json}`. `--output` wins when both are supplied.

In **text mode** (default / `--output pretty`), the header `Created preview branch:` writes to **stdout** followed by the single-row Glamour-styled list-table.

For `--output {json,yaml,toml,env}`, the same header writes to stdout followed by the encoded `V1CreateABranchOutput` payload.

In `--output-format json` / `stream-json`, a `success` event carries the response payload.

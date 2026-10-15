# `supabase branches create`

## Files Read

| Path                                           | Format                    | When                                                                                                                      |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                             |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                                  |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                                             |
| `<workdir>/supabase/.temp/linked-project.json` | JSON (`ref` field)        | when `--project-ref` is unset, as the 2nd PARENT-ref candidate (CLI-2167 follow-up — see `branches list/SIDE_EFFECTS.md`) |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset, as the 3rd (last) PARENT-ref candidate                     |
| `<cwd>/.git/HEAD` (walking parents)            | plain text                | when the positional `[name]` arg is omitted — fallback branch name detection                                              |

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
| `SUPABASE_YES`          | approves the hosted-mutation confirmation like `--yes` (shell environment only; `supabase/.env` is ignored)                                                        | no                                                      |

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

| Event                   | When                                            | Notable properties / groups                                       |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)      | `exit_code`, `duration_ms`, `flags` (`--project-ref` whitelisted) |
| `cli_upgrade_suggested` | on 4xx with `branching_limit` entitlement gated | `{feature_key: "branching_limit", org_slug}`                      |

## Output

Honors both `--output {pretty,json,yaml,toml,env}` and `--output-format {text,json,stream-json}`. `--output` wins when both are supplied.

In **text mode** (default / `--output pretty`), the header `Created preview branch:` writes to **stdout** followed by the single-row styled list-table.

For `--output {json,yaml,toml,env}`, the same header writes to stdout followed by the encoded `V1CreateABranchOutput` payload.

In `--output-format json` / `stream-json`, a `success` event carries the response payload.

## Notes

- Resolves the parent project and prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged.
- **Consent.** Asks once, after the parent project is resolved and the name is known (taken from the current git branch when `[name]` is omitted) and before the POST, with default Yes: `Create preview branch <name>`. The question lists the region, size, persistence and `--with-data` values that were set, and says when the name came from the git branch. The separate git-branch confirmation prompt is gone. `--yes` or a shell `SUPABASE_YES` approves it (`supabase/.env` does not) and echoes `Confirmed by --yes: <action> on <target>` to stderr. Without it, only an interactive text-mode terminal is asked: JSON, `-o`, piped and agent runs exit 1 with `HostedMutationConsentRequiredError` and change nothing, and declining exits 1 with `HostedMutationDeclinedError`. Stdin is never read.

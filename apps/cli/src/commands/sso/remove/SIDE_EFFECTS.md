# `supabase sso remove`

## Files Read

| Path                                           | Format                    | When                                                                                                            |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile`                   |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                        |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                                   |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                                  |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are unset, and as the linked parent for `--remote=<branch>` |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                                                                                                                                                                               |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |

## API Routes

| Method   | Path                                                         | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------ | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/projects`                                               | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`    | `/v1/projects/{parent}/branches`                             | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`    | `/v1/branches/{id}`                                          | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `DELETE` | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none         | `{id, saml?, domains?, created_at?, updated_at?}`                                                                                                                                                                                                        |
| `GET`    | `/v1/projects/{ref}`                                         | Bearer token | none         | `{organization_slug}` — upgrade-gate side-call on a 4xx with no plan-gate error in the body                                                                                                                                                              |
| `GET`    | `/v1/organizations/{slug}/entitlements`                      | Bearer token | none         | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate side-call on a 4xx with no plan-gate error in the body                                                                                                                                         |
| `GET`    | `/v1/projects/{ref}`                                         | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |

## Environment Variables

| Variable                | Purpose                                                                                               | Required?                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)                                                    | no (defaults to `supabase`)                             |
| `SUPABASE_YES`          | confirms the hosted mutation without asking; only the shell environment counts, never `supabase/.env` | no (falls back to the interactive prompt)               |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                |
| `1`  | `SsoInvalidUuidError` — provider ID is not a canonical UUID                                                                                                                                                            |
| `1`  | `SsoRemoveNotFoundError` — 404 from delete endpoint                                                                                                                                                                    |
| `1`  | `SsoRemoveUnexpectedStatusError` — other non-2xx                                                                                                                                                                       |
| `1`  | `SsoRemoveNetworkError` — transport-level failure                                                                                                                                                                      |
| `1`  | declined at the confirmation prompt (`HostedMutationDeclinedError`, `context canceled`) — nothing is changed                                                                                                           |
| `1`  | JSON, stream-json, `-o` or non-interactive run without `--yes` (`HostedMutationConsentRequiredError`) — nothing is changed                                                                                             |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` is recorded only when it is ref-shaped, never a branch name) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                                                                                                                                |

## Output

### `--output-format text` / `--output pretty`

Styled property/value markdown table showing the removed provider's details.

### `--output json` / `--output yaml` / `--output toml`

Response re-encoded per format (CLI-1975): JSON keeps snake_case keys, alphabetised, with HTML escaping (`<`/`>`/`&` as `\u003c`-style escapes — visible in `metadata_xml`); YAML uses lowercased field names (`metadataxml`, explicit `null` for nil values); TOML uses PascalCase field names (`MetadataXml`) with absent fields omitted.

### `--output env`

No output.

### `--output-format json` / `stream-json`

Single `success` event with the removed provider's details as data.

## Notes

- Removing a provider will prevent existing SSO users from logging in.
- The `<provider-id>` argument must be a valid UUID; UUIDs are accepted case-insensitively.
- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- Asks `Remove SSO provider <id> on <target>?` (default No) before the first write. `--yes` or a shell `SUPABASE_YES` confirms without asking; a piped `y` on stdin is never read. Without `--yes`, a non-interactive, JSON, stream-json or `-o` run fails with `HostedMutationConsentRequiredError`, and declining fails with `HostedMutationDeclinedError`; neither changes anything.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase sso remove` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that exactly matches a branch of the linked project, is
  within a small edit distance of one, or can't be checked because the branch listing failed stops
  the run before any other work with an error that offers both readings: `--remote=<word>` for the
  branch, `<word> --remote` for the operand. Any other word runs as the operand.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.

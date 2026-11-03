# `supabase sso remove`

Target: hosted, consent default No — see [Command target](../../../../docs/command-target.md)

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

| Code | Condition                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                    |
| `1`  | `SsoInvalidUuidError` — provider ID is not a canonical UUID                                                                |
| `1`  | `SsoRemoveNotFoundError` — 404 from delete endpoint                                                                        |
| `1`  | `SsoRemoveUnexpectedStatusError` — other non-2xx                                                                           |
| `1`  | `SsoRemoveNetworkError` — transport-level failure                                                                          |
| `1`  | declined at the confirmation prompt (`HostedMutationDeclinedError`, `context canceled`) — nothing is changed               |
| `1`  | JSON, stream-json, `-o` or non-interactive run without `--yes` (`HostedMutationConsentRequiredError`) — nothing is changed |

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
- Asks `Remove SSO provider <id> on <target>?` (default No) before the first write.

# `supabase sso show`

Target: hosted, no consent — see [Command target](../../../../docs/command-target.md)

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

| Method | Path                                                         | Auth         | Request body | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------ | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                                               | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`  | `/v1/projects/{parent}/branches`                             | Bearer token | none         | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`                                          | Bearer token | none         | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none         | `{id, saml?, domains?, created_at?, updated_at?}`                                                                                                                                                                                                        |
| `GET`  | `/v1/projects/{ref}`                                         | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |

Note: Unlike `list`/`add`/`update`/`remove`, `show` does **not** make upgrade-gate
side-calls.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                   |
| ---- | ----------------------------------------------------------- |
| `0`  | success                                                     |
| `1`  | `SsoInvalidUuidError` — provider ID is not a canonical UUID |
| `1`  | `SsoShowNotFoundError` — 404 from get endpoint              |
| `1`  | `SsoShowUnexpectedStatusError` — other non-2xx              |
| `1`  | `SsoShowEnvNotSupportedError` — `--output env` with show    |
| `1`  | `SsoShowNetworkError` — transport-level failure             |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                                                                                                                      |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` is recorded only when it is ref-shaped, never a branch name) |

## Output

### `--metadata`

Raw `response.saml.metadata_xml` (or empty string) followed by a single newline. Ignores `--output`.

### `--output-format text` / `--output pretty`

Styled property/value markdown table plus optional `## Attribute Mapping` and `## SAML 2.0 Metadata XML` sections.

### `--output json` / `--output yaml` / `--output toml`

Response re-encoded per format (CLI-1975): JSON keeps snake_case keys, alphabetised, with HTML escaping (`<`/`>`/`&` as `\u003c`-style escapes — visible in `metadata_xml`); YAML uses lowercased field names (`metadataxml`, explicit `null` for nil values); TOML uses PascalCase field names (`MetadataXml`) with absent fields omitted.

### `--output env`

**Not supported** — fails with `--output env flag is not supported`.

### `--output-format json` / `stream-json`

Single `success` event with the response as data.

## Notes

- The `<provider-id>` argument must be a valid UUID; invalid input produces `identity provider ID "<input>" is not a UUID`. UUIDs are accepted case-insensitively.
- `--metadata` short-circuits any `--output` selection.
- The `## SAML 2.0 Metadata XML` fenced block is pretty-printed via `formatSsoMetadataXml` (`sso.format.ts`), matching a 2-space-indented XML pretty-printer's output byte-for-byte.

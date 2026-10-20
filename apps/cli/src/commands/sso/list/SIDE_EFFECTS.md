# `supabase sso list`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are unset                             |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                                                                                                                                                                               |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |

## API Routes

| Method | Path                                           | Auth         | Request body | Response (used fields)                                                                                                                                                                                       |
| ------ | ---------------------------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/projects`                                 | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                               |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers` | Bearer token | none         | `{items: [{id, saml?, domains?, created_at?, updated_at?}]}`                                                                                                                                                 |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none         | `{organization_slug}` — upgrade-gate side-call on a 4xx with no plan-gate error in the body                                                                                                                  |
| `GET`  | `/v1/organizations/{slug}/entitlements`        | Bearer token | none         | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate side-call on a 4xx with no plan-gate error in the body                                                                                             |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success                                             |
| `1`  | `SsoListSamlDisabledError` — 404 from list endpoint |
| `1`  | `SsoListUnexpectedStatusError` — other non-2xx      |
| `1`  | `SsoListNetworkError` — transport-level failure     |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                               |

## Output

### `--output-format text` / `--output pretty`

Styled ASCII table with columns `TYPE`, `IDENTITY PROVIDER ID`, `DOMAINS`, `` SAML 2.0 `EntityID` ``, `CREATED AT (UTC)`, `UPDATED AT (UTC)`.

### `--output json` / `--output yaml` / `--output toml`

Encoded `{providers: items}` (CLI-1975): JSON keeps snake_case keys with alphabetised order; YAML lowercases item keys, TOML keeps PascalCase.

### `--output env`

Single `PROVIDERS=""` line — the flattening does not descend into slices.

### `--output-format json` / `stream-json`

Single `success` event with `{providers: items}` as data.

## Notes

- The `SAML 2.0 EntityID` header label is rendered as plain text, without inline-code backticks.
- Upgrade-gate side calls only fire on 4xx.

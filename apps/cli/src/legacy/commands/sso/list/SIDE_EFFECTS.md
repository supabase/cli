# `supabase sso list`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |

## Files Written

| Path                                           | Format | When                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves (Go `PersistentPostRun`) |

## API Routes

| Method | Path                                           | Auth         | Request body | Response (used fields)                                                     |
| ------ | ---------------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers` | Bearer token | none         | `{items: [{id, saml?, domains?, created_at?, updated_at?}]}`               |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none         | `{organization_slug}` — upgrade-gate side-call on 4xx                      |
| `GET`  | `/v1/organizations/{slug}/entitlements`        | Bearer token | none         | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate side-call on 4xx |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                 |
| ---- | --------------------------------------------------------- |
| `0`  | success                                                   |
| `1`  | `LegacySsoListSamlDisabledError` — 404 from list endpoint |
| `1`  | `LegacySsoListUnexpectedStatusError` — other non-2xx      |
| `1`  | `LegacySsoListNetworkError` — transport-level failure     |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                               |

## Output

### `--output-format text` / Go `--output pretty`

Glamour-styled ASCII table with columns `TYPE`, `IDENTITY PROVIDER ID`, `DOMAINS`, `` SAML 2.0 `EntityID` ``, `CREATED AT (UTC)`, `UPDATED AT (UTC)`.

### `--output json` / `--output yaml` / `--output toml`

Encoded `{providers: items}` (Go-compatible alphabetised keys for JSON).

### `--output env`

Single `PROVIDERS=""` line — Go's viper does not descend into slices.

### `--output-format json` / `stream-json`

Single `success` event with `{providers: items}` as data.

## Notes

- The `SAML 2.0 EntityID` header label is rendered as plain text; Go's markdown source writes `` SAML 2.0 `EntityID` `` and Glamour strips the inline-code backticks. Our flat ASCII renderer drops them at the source for byte parity with Glamour's output.
- Upgrade-gate side calls only fire on 4xx (matches Go's `plan_gate.go:29`).

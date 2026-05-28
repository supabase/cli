# `supabase sso remove`

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

| Method   | Path                                                         | Auth         | Request body | Response (used fields)                                    |
| -------- | ------------------------------------------------------------ | ------------ | ------------ | --------------------------------------------------------- |
| `DELETE` | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none         | `{id, saml?, domains?, created_at?, updated_at?}`         |
| `GET`    | `/v1/projects/{ref}`                                         | Bearer token | none         | `{organization_slug}` — upgrade-gate side-call on 4xx     |
| `GET`    | `/v1/organizations/{slug}/entitlements`                      | Bearer token | none         | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                         |
| ---- | ----------------------------------------------------------------- |
| `0`  | success                                                           |
| `1`  | `LegacySsoInvalidUuidError` — provider ID is not a canonical UUID |
| `1`  | `LegacySsoRemoveNotFoundError` — 404 from delete endpoint         |
| `1`  | `LegacySsoRemoveUnexpectedStatusError` — other non-2xx            |
| `1`  | `LegacySsoRemoveNetworkError` — transport-level failure           |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                               |

## Output

### `--output-format text` / Go `--output pretty`

Glamour-styled property/value markdown table showing the removed provider's details (Go behaviour).

### `--output json` / `--output yaml` / `--output toml`

Response verbatim (Go-compatible alphabetised keys for JSON).

### `--output env`

No output (matches Go's `remove.go:39`).

### `--output-format json` / `stream-json`

Single `success` event with the removed provider's details as data.

## Notes

- Removing a provider will prevent existing SSO users from logging in.
- The `<provider-id>` argument must be a valid UUID; UUIDs are accepted case-insensitively (matches Go's `uuid.Parse`).

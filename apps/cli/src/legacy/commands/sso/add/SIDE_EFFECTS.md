# `supabase sso add`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |
| `<metadata-file>`                              | XML (UTF-8)               | when `--metadata-file` is provided                                                            |
| `<attribute-mapping-file>`                     | JSON                      | when `--attribute-mapping-file` is provided                                                   |

## Files Written

| Path                                           | Format | When                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves (Go `PersistentPostRun`) |

## API Routes

| Method | Path                                           | Auth         | Request body                                                                          | Response (used fields)                                             |
| ------ | ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST` | `/v1/projects/{ref}/config/auth/sso/providers` | Bearer token | `{type, metadata_xml?, metadata_url?, domains?, attribute_mapping?, name_id_format?}` | `{id, saml?, domains?, created_at?, updated_at?}` (parsed loosely) |
| `GET`  | `<metadata-url>`                               | none         | `Accept: application/xml`, 10s timeout                                                | XML body (UTF-8) — validation when `--skip-url-validation` not set |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none                                                                                  | `{organization_slug}` — upgrade-gate side-call on 4xx              |
| `GET`  | `/v1/organizations/{slug}/entitlements`        | Bearer token | none                                                                                  | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate          |

Bypasses the typed Management API client for the POST so user-supplied keys inside
`attribute_mapping.keys.<x>` (e.g. `default`) are preserved verbatim — Go encodes the
same shape via an inline anonymous struct with `Default *any`.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                              |
| `1`  | `LegacySsoMutexFlagError` — `--metadata-file` and `--metadata-url` both set                                          |
| `1`  | `LegacySsoAddMetadataFileError` — metadata file unreadable, non-UTF-8, or metadata URL invalid/unreachable/non-UTF-8 |
| `1`  | `LegacySsoAddAttributeMappingFileError` — JSON file unreadable or malformed                                          |
| `1`  | `LegacySsoAddSamlDisabledError` — 404 from POST                                                                      |
| `1`  | `LegacySsoAddUnexpectedStatusError` — other non-2xx                                                                  |
| `1`  | `LegacySsoAddNetworkError` — transport-level failure                                                                 |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                               |

## Output

### `--output-format text` / Go `--output pretty`

Glamour-styled property/value markdown table plus optional `## Attribute Mapping` and `## SAML 2.0 Metadata XML` sections (heading + fenced code block).

### `--output json` / `--output yaml` / `--output toml`

Response verbatim (Go-compatible alphabetised keys for JSON).

### `--output env`

No output (matches Go's `create.go:94`).

### `--output-format json` / `stream-json`

Single `success` event with the parsed response as data.

## Notes

- `--type saml` is **required** (Go's `MarkFlagRequired("type")`).
- `--metadata-file` and `--metadata-url` are mutually exclusive.
- `--skip-url-validation` skips the HTTPS-only + 10s GET + UTF-8 body validation against the metadata URL.
- Metadata URL validation error message: `only HTTPS Metadata URLs are supported Use --skip-url-validation to suppress this error` (no trailing period — matches Go's `create.go:47`; differs from `sso update`'s variant).
- The `## Attribute Mapping` / `## SAML 2.0 Metadata XML` sections are emitted as plain markdown (heading + fence). Visual styling of the headings does not match Go's Glamour-rendered output; the XML body inside the fence is byte-parity via `formatSsoMetadataXml`.
- **Missing `--type` parser error**: the error message itself matches Go Cobra's `Error: required flag(s) "type" not set` verbatim (mapped in `shared/output/normalize-error.ts`). Effect CLI's parser however dumps the full help block to stdout _before_ the error, while Go Cobra shows usage only on explicit `--help`. The error string is parity; the surrounding help dump is an Effect CLI behavior that would require forking the CLI parser to suppress.

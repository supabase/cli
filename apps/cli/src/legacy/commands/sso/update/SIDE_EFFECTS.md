# `supabase sso update`

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

| Method | Path                                                         | Auth         | Request body                                                                    | Response (used fields)                                             |
| ------ | ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none                                                                            | `{id, saml?, domains?, created_at?, updated_at?}`                  |
| `PUT`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | `{metadata_xml?, metadata_url?, domains?, attribute_mapping?, name_id_format?}` | `{id, saml?, domains?, ...}` (parsed loosely)                      |
| `GET`  | `<metadata-url>`                                             | none         | `Accept: application/xml`, 10s timeout                                          | XML body (UTF-8) — validation when `--skip-url-validation` not set |
| `GET`  | `/v1/projects/{ref}`                                         | Bearer token | none                                                                            | `{organization_slug}` — upgrade-gate side-call on 4xx              |
| `GET`  | `/v1/organizations/{slug}/entitlements`                      | Bearer token | none                                                                            | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate          |

Bypasses the typed Management API client for the PUT so user-supplied keys inside
`attribute_mapping.keys.<x>` (e.g. `default`) are preserved verbatim. The initial
GET still uses the typed client.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                                                              |
| `1`  | `LegacySsoInvalidUuidError` — provider ID is not a canonical UUID                                                                    |
| `1`  | `LegacySsoMutexFlagError` — flag combinations: `--domains` with `--add/--remove-domains`, or `--metadata-file` with `--metadata-url` |
| `1`  | `LegacySsoUpdateMetadataFileError` — metadata file unreadable, non-UTF-8, or metadata URL invalid/unreachable/non-UTF-8              |
| `1`  | `LegacySsoUpdateAttributeMappingFileError` — JSON file unreadable or malformed                                                       |
| `1`  | `LegacySsoUpdateNotFoundError` — 404 from GET                                                                                        |
| `1`  | `LegacySsoUpdateUnexpectedStatusError` — non-2xx from GET or PUT                                                                     |
| `1`  | `LegacySsoUpdateNetworkError` — transport-level failure                                                                              |

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

No output (matches Go's `update.go:139`).

### `--output-format json` / `stream-json`

Single `success` event with the parsed response as data.

## Notes

- `--domains` is mutually exclusive with `--add-domains` and `--remove-domains`.
- `--metadata-file` and `--metadata-url` are mutually exclusive.
- Always performs the GET pre-check (matches Go's `update.go:42`), regardless of whether `--add-domains` / `--remove-domains` are used.
- Domain merge: removals are applied first, then additions. Go uses a `map[string]bool` so the resulting order is **unordered**; consumers must sort if comparing.
- Metadata URL validation error message: `only HTTPS Metadata URLs are supported Use --skip-url-validation to suppress this error.` (single trailing period — matches Go's `update.go:69`, which wraps with `%w Use --skip-url-validation to suppress this error.`; differs from `sso add`'s variant which omits the trailing period).
- The `## Attribute Mapping` / `## SAML 2.0 Metadata XML` sections are emitted as plain markdown (heading + fence). Visual styling of the headings does not match Go's Glamour-rendered output; the table portion and the XML body inside the fence are byte-parity (see `formatSsoMetadataXml`).
- **PUT failure message reuses the GET error string**: a non-2xx PUT response produces `unexpected error fetching identity provider: <body>` — note "fetching" not "updating". This matches Go's `update.go:133` verbatim.

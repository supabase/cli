# `supabase sso add`

## Files Read

| Path                                           | Format                    | When                                                                                            |
| ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliSettings.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                        |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                   |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                  |
| `<metadata-file>`                              | XML (UTF-8)               | when `--metadata-file` is provided                                                              |
| `<attribute-mapping-file>`                     | JSON                      | when `--attribute-mapping-file` is provided                                                     |

## Files Written

| Path                                           | Format | When                                             |
| ---------------------------------------------- | ------ | ------------------------------------------------ |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`) |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves       |

## API Routes

| Method | Path                                           | Auth         | Request body                                                                          | Response (used fields)                                             |
| ------ | ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST` | `/v1/projects/{ref}/config/auth/sso/providers` | Bearer token | `{type, metadata_xml?, metadata_url?, domains?, attribute_mapping?, name_id_format?}` | `{id, saml?, domains?, created_at?, updated_at?}` (parsed loosely) |
| `GET`  | `<metadata-url>`                               | none         | `Accept: application/xml`, 10s timeout                                                | XML body (UTF-8) — validation when `--skip-url-validation` not set |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none                                                                                  | `{organization_slug}` — upgrade-gate side-call on 4xx              |
| `GET`  | `/v1/organizations/{slug}/entitlements`        | Bearer token | none                                                                                  | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate          |

Bypasses the typed Management API client for the POST so user-supplied keys inside
`attribute_mapping.keys.<x>` (e.g. `default`) are preserved verbatim.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                                                                        |
| `1`  | `LegacySsoInvalidFlagValueError` — a `--type`/`--skip-url-validation`/`--name-id-format` occurrence pflag's `Value.Set` would reject (enum membership / `strconv.ParseBool`; fails before every validation; no request)                                                                                        |
| `1`  | malformed CSV in a `--domains` value — fails during flag parsing, before the handler and telemetry, with pflag's exact diagnostic on stderr (e.g. `invalid argument "a\"b" for "--domains" flag: parse error on line 1, column 2: bare " in non-quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | `LegacySsoFlagNeedsArgumentError` — a bare value-taking flag is the final argv token (pflag `ValueRequiredError`, fails before every validation; no request)                                                                                                                                                   |
| `1`  | `LegacyProfileLoadError` — the pflag/viper-effective `--profile`/`SUPABASE_PROFILE` cannot be loaded the way the old Go CLI's profile loader loaded it (before the workdir change; beats the workdir, required-flag, and mutex checks; no request)                                                             |
| `1`  | `LegacyPflagWorkdirError` — the pflag/viper-effective `--workdir`/`SUPABASE_WORKDIR` is not an existing directory (the old Go CLI's workdir-change step; beats the required-flag and mutex checks; no request)                                                                                                 |
| `1`  | `LegacySsoAddRequiredFlagError` — pflag consumed the `--type`/`-t` token as another flag's value (cobra `ValidateRequiredFlags`)                                                                                                                                                                               |
| `1`  | `LegacySsoMutexFlagError` — `--metadata-file` and `--metadata-url` both set                                                                                                                                                                                                                                    |
| `1`  | `LegacySsoAddMetadataFileError` — metadata file unreadable, non-UTF-8, or metadata URL invalid/unreachable/non-UTF-8                                                                                                                                                                                           |
| `1`  | `LegacySsoAddAttributeMappingFileError` — JSON file unreadable or malformed                                                                                                                                                                                                                                    |
| `1`  | `LegacySsoAddSamlDisabledError` — 404 from POST                                                                                                                                                                                                                                                                |
| `1`  | `LegacySsoAddUnexpectedStatusError` — other non-2xx                                                                                                                                                                                                                                                            |
| `1`  | `LegacySsoAddNetworkError` — transport-level failure                                                                                                                                                                                                                                                           |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                               |

## Output

### `--output-format text` / `--output pretty`

Glamour-styled property/value markdown table plus optional `## Attribute Mapping` and `## SAML 2.0 Metadata XML` sections (heading + fenced code block).

### `--output json` / `--output yaml` / `--output toml`

Response re-encoded per format (CLI-1975): JSON keeps snake_case keys, alphabetised, with HTML escaping (`<`/`>`/`&` as `\u003c`-style escapes — visible in `metadata_xml`); YAML uses lowercased field names (`metadataxml`, explicit `null` for nil values); TOML uses PascalCase field names (`MetadataXml`) with absent fields omitted.

### `--output env`

No output.

### `--output-format json` / `stream-json`

Single `success` event with the parsed response as data.

## Notes

- `--type saml` is **required**.
- `--metadata-file` and `--metadata-url` are mutually exclusive. Violations emit the exact template: `if any flags in the group [metadata-file metadata-url] are set none of the others can be; [metadata-file metadata-url] were all set`. "Set" follows `pflag.Changed` semantics — an explicit empty value (`--metadata-file=`) still counts.
- Flag values follow pflag's consumption rules, not the TS parser's: every value the handler acts on (`--project-ref`, `--metadata-file`, `--metadata-url`, `--attribute-mapping-file`, `--domains`, `--name-id-format`, `--skip-url-validation`) is reconciled against a pflag-faithful raw-argv scan. E.g. `--project-ref --metadata-file x.xml --metadata-url u` hands `--metadata-file` to `--project-ref` as its value and fails ref validation — the metadata file is never read (CLI-1982). Repeated flags resolve last-wins (pflag Sets every occurrence; the TS parser is first-wins), and an occurrence pflag's `Value.Set` would reject — `--type` outside `[ saml ]`, a boolean outside the accepted spellings (`--skip-url-validation=yes`), or a `--name-id-format` outside the enum — fails with pflag's exact `invalid argument …` message before every validation and request.
- Required-ness follows pflag too: when the `--type` token is itself consumed as another flag's value (`--domains --type saml`), the command fails with the exact `required flag(s) "type" not set` before any request (required-flags validation runs before flag-group validation). `-t` shorthand occurrences are recognised by the scan and never trip this.
- The workdir follows pflag/viper too: the workdir-change step chdir's to the effective `--workdir` (last occurrence, even a flag-shaped consumed token like `--workdir --metadata-file`) or `SUPABASE_WORKDIR`, and a missing directory aborts with the exact `failed to change workdir: chdir …` before the required-flag check, the mutex check, and any request. A changed-but-empty `--workdir=` shadows the env var and falls back to the always-valid project-root walk-up, exactly like viper.
- The profile follows pflag/viper too (PR #5974 round 7): whenever the pflag-effective `--profile`/`SUPABASE_PROFILE` token differs from the one the Effect parser gave the config layer (a `--profile` token consumed by another flag — `--domains --profile alternate.yml` targets the env/default profile, not `alternate.yml`; a flag-shaped consumed value — `--profile --metadata-url`; repeats, which pflag resolves last-wins; an explicit `--profile supabase` shadowing the env; an untrimmed/empty persisted `~/.supabase/profile` file), the handler re-runs the profile loader on the effective token (`legacy-profile-load.ts`) — the POST targets that profile's `api_url`, and a token that can't be loaded aborts with the matching error (`failed to read profile: …` / `failed to parse profile: …` / `invalid profile: …`, byte-exact for the deterministic classes) before the workdir check and any request. Where the scan and the parser agree — every normal invocation — the config layer's resolution (including its pre-existing lenient missing/malformed-file fallback, which predates CLI-1982 and applies shell-wide) is used unchanged. The upgrade-gate fallback GETs and the linked-project cache fill also target the reconciled host.
- Accepted micro-divergences of the profile emulation (each fail-closed: both CLIs exit 1 with zero requests; only stderr detail can differ): YAML parse-failure detail text (JS `yaml` vs go-yaml, shared `failed to read profile: While parsing config: ` prefix); non-YAML/JSON viper config types (`.toml`, `.env`, …) parsed as YAML; `http_url`/`hostname_rfc1123`/`uuid4` validator tags approximated; the final line of a padded multi-line error loses its trailing spaces to the shared error normalizer's trim. Also: when the effective and layer profiles differ AND the token is keyring-relevant, the keyring token lookup still uses the layer profile's name (env-token flows, e.g. the cli-e2e harness, are unaffected), and the upgrade-suggestion billing URL keeps the layer profile's dashboard host.
- `--skip-url-validation` skips the HTTPS-only + 10s GET + UTF-8 body validation against the metadata URL.
- Metadata URL validation error message: `only HTTPS Metadata URLs are supported Use --skip-url-validation to suppress this error` (no trailing period; differs from `sso update`'s variant).
- The `## Attribute Mapping` / `## SAML 2.0 Metadata XML` sections are emitted as plain markdown (heading + fence). Visual styling of the headings does not match the old Glamour-rendered output; the XML body inside the fence is byte-parity via `formatSsoMetadataXml`.
- **Missing `--type` parser error**: the error message itself is `Error: required flag(s) "type" not set` verbatim (mapped in `shared/output/normalize-error.ts`). Effect CLI's parser however dumps the full help block to stdout _before_ the error, unlike the old CLI, which showed usage only on explicit `--help`. The error string is unchanged; the surrounding help dump is an Effect CLI behavior that would require forking the CLI parser to suppress.

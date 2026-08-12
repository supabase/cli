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

| Path                                           | Format | When                                             |
| ---------------------------------------------- | ------ | ------------------------------------------------ |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`) |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves       |

## API Routes

| Method | Path                                                         | Auth         | Request body                                                                   | Response (used fields)                                             |
| ------ | ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none                                                                           | `{id, saml?, domains?, created_at?, updated_at?}`                  |
| `PUT`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | `{metadata_xml?, metadata_url?, domains, attribute_mapping?, name_id_format?}` | `{id, saml?, domains?, ...}` (parsed loosely)                      |
| `GET`  | `<metadata-url>`                                             | none         | `Accept: application/xml`, 10s timeout                                         | XML body (UTF-8) — validation when `--skip-url-validation` not set |
| `GET`  | `/v1/projects/{ref}`                                         | Bearer token | none                                                                           | `{organization_slug}` — upgrade-gate side-call on 4xx              |
| `GET`  | `/v1/organizations/{slug}/entitlements`                      | Bearer token | none                                                                           | `{entitlements[].feature.key, .hasAccess}` — upgrade-gate          |

Bypasses the typed Management API client for the PUT so user-supplied keys inside
`attribute_mapping.keys.<x>` (e.g. `default`) are preserved verbatim. The initial
GET still uses the typed client.

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                                                                                                           |
| `1`  | `LegacySsoInvalidFlagValueError` — a `--skip-url-validation`/`--name-id-format` occurrence pflag's `Value.Set` would reject (`strconv.ParseBool` / enum membership; fails before every validation; no request)                                                                                                                                    |
| `1`  | malformed CSV in a `--domains`/`--add-domains`/`--remove-domains` value — fails during flag parsing, before the handler and telemetry, with pflag's exact diagnostic on stderr (e.g. `invalid argument "a\"b" for "--domains" flag: parse error on line 1, column 2: bare " in non-quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | `LegacySsoFlagNeedsArgumentError` — a bare value-taking flag is the final argv token (pflag `ValueRequiredError`, fails before `ValidateArgs`; no request)                                                                                                                                                                                        |
| `1`  | `LegacySsoUpdateArityError` — pflag-effective positional count ≠ 1 (cobra `ValidateArgs`/`ExactArgs(1)`; a consumed flag token orphans its parser-value into the positionals)                                                                                                                                                                     |
| `1`  | `LegacyProfileLoadError` — the pflag/viper-effective `--profile`/`SUPABASE_PROFILE` cannot be loaded the way the old Go CLI's profile loader loaded it (before the workdir change; loses to the arity check, beats the workdir and mutex checks; no request)                                                                                      |
| `1`  | `LegacyPflagWorkdirError` — the pflag/viper-effective `--workdir`/`SUPABASE_WORKDIR` is not an existing directory (the old Go CLI's workdir-change step; loses to the arity check, beats the mutex checks; no request)                                                                                                                            |
| `1`  | `LegacySsoInvalidUuidError` — provider ID is not a canonical UUID                                                                                                                                                                                                                                                                                 |
| `1`  | `LegacySsoMutexFlagError` — flag combinations: `--domains` with `--add/--remove-domains`, or `--metadata-file` with `--metadata-url`                                                                                                                                                                                                              |
| `1`  | `LegacySsoUpdateMetadataFileError` — metadata file unreadable, non-UTF-8, or metadata URL invalid/unreachable/non-UTF-8                                                                                                                                                                                                                           |
| `1`  | `LegacySsoUpdateAttributeMappingFileError` — JSON file unreadable or malformed                                                                                                                                                                                                                                                                    |
| `1`  | `LegacySsoUpdateNotFoundError` — 404 from GET                                                                                                                                                                                                                                                                                                     |
| `1`  | `LegacySsoUpdateUnexpectedStatusError` — non-2xx from GET or PUT                                                                                                                                                                                                                                                                                  |
| `1`  | `LegacySsoUpdateNetworkError` — transport-level failure                                                                                                                                                                                                                                                                                           |

## Telemetry Events Fired

| Event                   | When                                                 | Notable properties                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli_command_executed`  | post-run, success or failure (via wrapper)           | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |
| `cli_upgrade_suggested` | 4xx response **and** `auth.saml_2` entitlement gated | `feature_key: "auth.saml_2"`, `org_slug`                               |

## Output

### `--output-format text` / `--output pretty`

Glamour-styled property/value markdown table plus optional `## Attribute Mapping` and `## SAML 2.0 Metadata XML` sections (heading + fenced code block).

### `--output json` / `--output yaml` / `--output toml`

Response re-encoded per format (CLI-1975): JSON keeps snake_case keys, alphabetised, with Go's HTML escaping (`<`/`>`/`&` as `\u003c`-style escapes — visible in `metadata_xml`); YAML uses lowercased field names (`metadataxml`, explicit `null` for nil values); TOML uses PascalCase field names (`MetadataXml`) with absent fields omitted.

### `--output env`

No output.

### `--output-format json` / `stream-json`

Single `success` event with the parsed response as data.

## Notes

- `--domains` is mutually exclusive with `--add-domains` and `--remove-domains`.
- `--metadata-file` and `--metadata-url` are mutually exclusive.
- Flag values follow pflag's consumption rules, not the TS parser's: every value the handler acts on (`--project-ref`, `--metadata-file`, `--metadata-url`, `--attribute-mapping-file`, the three domain slices, `--name-id-format`, `--skip-url-validation`) is reconciled against a pflag-faithful raw-argv scan — same mechanism as `sso add` (CLI-1982). Repeated flags resolve last-wins (pflag Sets every occurrence; the TS parser is first-wins), and an occurrence pflag's `Value.Set` would reject — a boolean outside the accepted spellings (`--skip-url-validation=yes`), or a `--name-id-format` outside the enum — fails with pflag's exact `invalid argument …` message before any validation or request.
- Positional arity follows pflag too: the exact-one-argument rule is re-counted over pflag-effective positionals (arity validation runs before every hook and flag validation), so a consumed flag token that orphans its parser-value (`--domains --metadata-url u <id>`) fails with the exact `accepts 1 arg(s), received 2` before the GET — and wins over both the mutex and invalid-UUID errors.
- The workdir follows pflag/viper too: the workdir-change step chdir's to the effective `--workdir` (last occurrence, even a flag-shaped consumed token like `--workdir --metadata-file`) or `SUPABASE_WORKDIR`, and a missing directory aborts with the exact `failed to change workdir: chdir …` after the arity check but before the mutex checks and any request. A changed-but-empty `--workdir=` shadows the env var and falls back to the always-valid project-root walk-up, exactly like viper.
- The profile follows pflag/viper too (PR #5974 round 7): whenever the pflag-effective `--profile`/`SUPABASE_PROFILE` token differs from the one the Effect parser gave the config layer (repeats — pflag is last-wins where the parser is first-wins, so `--profile a.yml --profile b.yml` GETs and PUTs `b.yml`'s `api_url`; a flag-shaped consumed value — `--profile --add-domains`; an explicit `--profile supabase` shadowing the env; an untrimmed/empty persisted `~/.supabase/profile` file), the handler re-runs the profile loader on the effective token (`legacy-profile-load.ts`). Both the initial GET and the PUT then target that profile's `api_url` — the GET is issued through the raw HTTP client because the typed client bakes the layer's `api_url` in at construction — and a token that can't be loaded aborts with the matching error (`failed to read profile: …` / `failed to parse profile: …` / `invalid profile: …`, byte-exact for the deterministic classes) after the arity check, before the workdir and mutex checks and any request. The raw GET mirrors the old typed client's behavior on the 200 path too: an undecodable JSON body aborts with `failed to get sso provider: <detail>` before any PUT (detail text is JS `JSON.parse`'s — micro-divergence), a 200 without a JSON content type falls into the gate + unexpected-status branch, and the response is stitched through the shared per-command identity guard exactly like the typed client. The upgrade-gate fallback GETs and the linked-project cache fill also target the reconciled host. Where the scan and the parser agree — every normal invocation — the config layer's resolution (including its pre-existing lenient missing/malformed-file fallback, which predates CLI-1982 and applies shell-wide) is used unchanged, via the typed client.
- Accepted micro-divergences of the profile emulation (each fail-closed: both CLIs exit 1 with zero requests; only stderr detail can differ): YAML parse-failure detail text (JS `yaml` vs go-yaml, shared `failed to read profile: While parsing config: ` prefix); non-YAML/JSON viper config types (`.toml`, `.env`, …) parsed as YAML; `http_url`/`hostname_rfc1123`/`uuid4` validator tags approximated; the final line of a padded multi-line error loses its trailing spaces to the shared error normalizer's trim. Also: when the effective and layer profiles differ AND the token is keyring-relevant, the keyring token lookup still uses the layer profile's name (env-token flows, e.g. the cli-e2e harness, are unaffected), and the upgrade-suggestion billing URL keeps the layer profile's dashboard host.
- Always performs the GET pre-check, regardless of whether `--add-domains` / `--remove-domains` are used.
- Domain merge: removals are applied first, then additions. The result is **unordered**; consumers must sort if comparing.
- **`domains` is always present in the PUT body** (CLI-1981): `--add-domains`/`--remove-domains` default to a non-nil empty array, so the merge gate is always true from the CLI. With no domain flags (or an explicit empty `--domains=`) the body carries the recomputed existing set; when the provider has no domains it is the literal `"domains":[]`.
- Metadata URL validation error message: `only HTTPS Metadata URLs are supported Use --skip-url-validation to suppress this error.` (single trailing period; differs from `sso add`'s variant which omits the trailing period).
- The `## Attribute Mapping` / `## SAML 2.0 Metadata XML` sections are emitted as plain markdown (heading + fence). Visual styling of the headings does not match the old Glamour-rendered output; the table portion and the XML body inside the fence are byte-parity (see `formatSsoMetadataXml`).
- **PUT failure message reuses the GET error string**: a non-2xx PUT response produces `unexpected error fetching identity provider: <body>` — note "fetching" not "updating".

# `supabase sso show`

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

| Method | Path                                                         | Auth         | Request body | Response (used fields)                            |
| ------ | ------------------------------------------------------------ | ------------ | ------------ | ------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/config/auth/sso/providers/{provider_id}` | Bearer token | none         | `{id, saml?, domains?, created_at?, updated_at?}` |

Note: Unlike `list`/`add`/`update`/`remove`, `show` does **not** make upgrade-gate
side-calls — matches Go's `get.go`.

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
| `1`  | `LegacySsoShowNotFoundError` — 404 from get endpoint              |
| `1`  | `LegacySsoShowUnexpectedStatusError` — other non-2xx              |
| `1`  | `LegacySsoShowEnvNotSupportedError` — `--output env` with show    |
| `1`  | `LegacySsoShowNetworkError` — transport-level failure             |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |

## Output

### `--metadata`

Raw `response.saml.metadata_xml` (or empty string) followed by a single newline. Ignores `--output`.

### `--output-format text` / Go `--output pretty`

Glamour-styled property/value markdown table plus optional `## Attribute Mapping` and `## SAML 2.0 Metadata XML` sections.

### `--output json` / `--output yaml` / `--output toml`

Response verbatim (Go-compatible alphabetised keys for JSON).

### `--output env`

**Not supported** — fails with `--output env flag is not supported` (matches Go's `utils.ErrEnvNotSupported` in `apps/cli-go/internal/utils/output.go:41` verbatim).

### `--output-format json` / `stream-json`

Single `success` event with the response as data.

## Notes

- The `<provider-id>` argument must be a valid UUID; invalid input produces `identity provider ID "<input>" is not a UUID`. UUIDs are accepted case-insensitively (matches Go's `uuid.Parse`).
- `--metadata` short-circuits any `--output` selection.
- The `## SAML 2.0 Metadata XML` fenced block is pretty-printed via a Go-xmlfmt-equivalent (`formatSsoMetadataXml` in `sso.format.ts`) — byte-parity with `xmlfmt.FormatXML(..., "  ", "  ")` at `apps/cli-go/internal/sso/internal/render/render.go:155`.

# `supabase sso info`

## Files Read

| Path                                           | Format                    | When                                                                                          |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `CommandSettings.profile` |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                 |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are unset                             |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always — `linkedProjectCache` reads to decide whether to write                                |

`info` makes no Management API call of its own, but the Management API client is built eagerly, so an
access token is required: a missing one fails before the handler runs.

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                                                                                                                                                                               |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |

## API Routes

`info` derives all three URLs locally from the project ref and makes no Management API call of its
own. The ref resolution and the cache fill still call the API:

| Method | Path                 | Auth         | Request body | Response (used fields)                                                                                                                                                                                       |
| ------ | -------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/projects`       | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                               |
| `GET`  | `/v1/projects/{ref}` | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | profile selector (built-in name or YAML file path)   | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                  |
| ---- | ---------------------------------------------------------- |
| `0`  | success                                                    |
| `1`  | `InvalidProjectRefError` — ref doesn't match `^[a-z]{20}$` |
| `1`  | `ProjectRefNotLinkedError` — no ref source available       |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |

## Output

The payload is `{acs_url, entity_id, relay_state}` where each URL is derived from
the project ref: `https://<ref>.supabase.co/auth/v1/sso/saml/{acs,metadata}` and
`https://<ref>.supabase.co`.

### `--output-format text` / `--output pretty`

Glamour-styled 3-row property/value markdown table.

### `--output json` / `--output yaml` / `--output toml`

Encoded payload (alphabetised keys for JSON).

### `--output env`

`ACS_URL="…"`, `ENTITY_ID="…"`, `RELAY_STATE="…"` lines, alphabetised by key.

### `--output-format json` / `stream-json`

Single `success` event with the payload as data.

## Notes

- All three URLs are deterministic functions of the project ref.
- The old Go CLI's markdown source included a trailing space in the `Single sign-on URL (ACS URL) ` label, but Glamour collapses it when computing column widths. Our flat ASCII renderer would double it up against the cell padding, so the label is emitted without the trailing space to match that rendered output (which the cli-e2e parity harness compares against).

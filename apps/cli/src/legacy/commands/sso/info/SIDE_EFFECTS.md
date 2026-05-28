# `supabase sso info`

## Files Read

| Path                                           | Format | When                                                           |
| ---------------------------------------------- | ------ | -------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | always — `linkedProjectCache` reads to decide whether to write |

`info` makes **no** API call, so no access-token lookup occurs.

## Files Written

| Path                                           | Format | When                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                   | JSON   | always (`Effect.ensuring(telemetryState.flush)`)                    |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | best-effort after `--project-ref` resolves (Go `PersistentPostRun`) |

## API Routes

`info` derives all three URLs locally from the project ref. No Management API
calls are made.

## Environment Variables

| Variable           | Purpose                                            | Required?                   |
| ------------------ | -------------------------------------------------- | --------------------------- |
| `SUPABASE_PROFILE` | profile selector (built-in name or YAML file path) | no (defaults to `supabase`) |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success                                                          |
| `1`  | `LegacyInvalidProjectRefError` — ref doesn't match `^[a-z]{20}$` |
| `1`  | `LegacyProjectNotLinkedError` — no ref source available          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                     |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` allowed verbatim) |

## Output

The payload is `{acs_url, entity_id, relay_state}` where each URL is derived from
the project ref: `https://<ref>.supabase.co/auth/v1/sso/saml/{acs,metadata}` and
`https://<ref>.supabase.co`.

### `--output-format text` / Go `--output pretty`

Glamour-styled 3-row property/value markdown table.

### `--output json` / `--output yaml` / `--output toml`

Encoded payload (Go-compatible alphabetised keys for JSON).

### `--output env`

`ACS_URL="…"`, `ENTITY_ID="…"`, `RELAY_STATE="…"` lines, alphabetised by key.

### `--output-format json` / `stream-json`

Single `success` event with the payload as data.

## Notes

- All three URLs are deterministic functions of the project ref.
- Go's markdown source at `render.go:170` includes a trailing space in the `Single sign-on URL (ACS URL) ` label, but Glamour collapses it when computing column widths. Our flat ASCII renderer would double it up against the cell padding, so the label is emitted without the trailing space to match Go's rendered output (which the cli-e2e parity harness compares against).

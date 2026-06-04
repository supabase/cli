# `supabase login`

Native TypeScript port of Go's `internal/login`. Writes the access token, then
stitches/clears the telemetry identity and captures `cli_login_completed`.

## Files Read

| Path                                    | Format                    | When                                                                       |
| --------------------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| stdin                                   | plain text (token string) | non-TTY only, when `--token` is unset and `SUPABASE_ACCESS_TOKEN` is unset |
| OS keyring / `~/.supabase/access-token` | token string              | written, not read, on the login path                                       |

## Files Written

| Path                                            | Format                    | When                                                                                                                                   |
| ----------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OS keyring (`Supabase CLI` / profile)           | token string              | always on success when the keyring is available                                                                                        |
| `~/.supabase/access-token`                      | plain text (mode `0600`)  | on success when the keyring is unavailable (WSL / `SUPABASE_NO_KEYRING`)                                                               |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON                      | always (PersistentPostRun flush); `distinct_id` set on stitch, removed on clear                                                        |
| `~/.supabase/profile`                           | plain text (profile name) | on success only, when a profile is explicitly set (`--profile` ≠ default, else `SUPABASE_PROFILE`) — Go's `PostRunE`/`SaveProfileName` |

## API Routes

| Method | Path                                                          | Auth                     | Request body | Response (used fields)                                        |
| ------ | ------------------------------------------------------------- | ------------------------ | ------------ | ------------------------------------------------------------- |
| `GET`  | `{dashboardUrl}/cli/login?session_id&token_name&public_key`   | none (opened in browser) | none         | — (not fetched by the CLI)                                    |
| `GET`  | `{apiHost}/platform/cli/login/{sessionId}?device_code=<code>` | none                     | none         | `{access_token, public_key, nonce}` (10s timeout, expect 200) |
| `GET`  | `{apiHost}/v1/profile`                                        | Bearer (saved token)     | none         | `{gotrue_id}` (best-effort, for the telemetry stitch)         |

## Environment Variables

| Variable                                       | Purpose                                                | Required?                                                 |
| ---------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                        | non-interactive token source                           | no (falls back to `--token` → piped stdin → browser flow) |
| `SUPABASE_NO_KEYRING`                          | disables the OS keyring, forcing the file fallback     | no                                                        |
| `CLAUDECODE` / `CLAUDE_CODE`                   | enables the Claude Code plugin hint (TTY stdout only)  | no                                                        |
| `DO_NOT_TRACK` / `SUPABASE_TELEMETRY_DISABLED` | suppress analytics delivery (state file still written) | no                                                        |

## Exit Codes

| Code | Condition                                                                                   |
| ---- | ------------------------------------------------------------------------------------------- |
| `0`  | success (token path or browser path)                                                        |
| `1`  | invalid `--token` (`cannot save provided token: …`)                                         |
| `1`  | non-TTY with no token (`Cannot use automatic login flow inside non-TTY environments. …`)    |
| `1`  | keygen failure, verification retries exhausted, or decryption failure (browser path)        |
| `1`  | failure to persist `~/.supabase/profile` (Go blocks subsequent CI commands on save failure) |

Browser-open failure is non-fatal (logged, ignored — `login.go:206-208`).

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / identity                            |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `cli_login_completed`  | after the token persists                   | rides the stitched `gotrue_id` (`alias` + `distinct_id`) |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`                      |

## Output

### `--output-format text` (Go CLI compatible)

Token path (stdout): `You are now logged in. Happy coding!`

Browser path (stdout): `Hello from Supabase! Press Enter to open browser and login automatically.`,
then (after Enter) `Here is your login link in case browser did not open <url>`; with
`--no-browser`: `Here is your login link, open it in the browser <url>`. On success:
`Token <name> created successfully.` then `You are now logged in. Happy coding!`.

stderr: verification prompt `Enter your verification code`, retry notices
`<err>\nRetry (n/2): `, and the Claude Code hint (when applicable).

### `--output-format json` / `stream-json`

Emits a single structured `success` result (`You are now logged in.`); human banners
are suppressed. Interactive prompts (browser path) fail with `NonInteractiveError`.

## Notes

- Token resolution priority: `--token` → `SUPABASE_ACCESS_TOKEN` → piped stdin (non-TTY) → browser flow (TTY).
- The login-session query string is built without URL-encoding, matching Go (`login.go:197-198`).
- Telemetry stitch always replaces a stale `distinct_id` (Go's `StitchLogin`), independent of the platform-API auto-stitch. The stitch _aliases_ only — Go's login never calls `identify`.
- On success, an explicitly-set profile is persisted to `~/.supabase/profile` (Go's `PostRunE`); `LegacyCliConfig` reads it back as the lowest-precedence profile source.
- Aqua/Bold styling from Go renders as plain text (parity on a non-TTY).

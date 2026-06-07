# `supabase logout`

Native TypeScript port of Go's `internal/logout`. Deletes the access token and
sweeps all stored project credentials. Makes no API calls.

## Files Read

| Path                       | Format                    | When                                                 |
| -------------------------- | ------------------------- | ---------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | existence is checked before removal (no token parse) |

## Files Written

| Path                                            | Format | When                                                                         |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `~/.supabase/access-token`                      | —      | deleted first, always (a missing file is ignored)                            |
| OS keyring (`Supabase CLI` namespace)           | —      | the access-token entries **and** all project DB-password entries are deleted |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always (PersistentPostRun flush)                                             |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable               | Purpose                                            | Required? |
| ---------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_YES`/`--yes` | auto-confirm the logout prompt                     | no        |
| `SUPABASE_NO_KEYRING`  | disables the OS keyring (forces the file fallback) | no        |

## Exit Codes

| Code | Condition                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | success — token + project credentials deleted                                                  |
| `0`  | not logged in — profile keyring entry absent / keyring unavailable (prints to stderr)          |
| `1`  | user declines the confirmation prompt (`context canceled`)                                     |
| `1`  | a real removal failure — non-`ENOENT` file remove error or a real profile-keyring delete error |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups |
| ---------------------- | ------------------------------------------ | --------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`  |

## Output

### `--output-format text` (Go CLI compatible)

stdout (success): `Access token deleted successfully. You are now logged out.`

stderr: the confirm prompt `Do you want to log out? This will remove the access token
from your system.`; the not-logged-in notice `You were not logged in, nothing to do.`

### `--output-format json` / `stream-json`

Emits a single structured `success` result. Without `--yes`, the confirm prompt fails
with `NonInteractiveError` in these modes.

## Notes

- **Deliberate Go quirk (parity):** `deleteAccessToken` removes the file first, but the
  outcome is decided solely by the profile-keyring delete. On a no-keyring host
  (WSL / `SUPABASE_NO_KEYRING`) or when the token lived only in the file, the file is
  removed yet logout still reports `You were not logged in, nothing to do.` and exits 0.
- The legacy `access-token` keyring entry delete is best-effort — its failure never
  changes the outcome.
- Project DB-password credentials are swept only after a successful token delete; the
  sweep is best-effort and never fails (Go's `StoreProvider.DeleteAll`).

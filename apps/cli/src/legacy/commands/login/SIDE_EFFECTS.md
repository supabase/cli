# `supabase login`

## Files Read

| Path                       | Format                    | When                                         |
| -------------------------- | ------------------------- | -------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | not read; login writes this file             |
| stdin                      | plain text (token string) | when piped input is detected in non-TTY mode |

## Files Written

| Path                       | Format                    | When                                             |
| -------------------------- | ------------------------- | ------------------------------------------------ |
| `~/.supabase/access-token` | plain text (token string) | when keyring is unavailable; stores access token |

## API Routes

| Method | Path                            | Auth | Request body | Response (used fields)                                   |
| ------ | ------------------------------- | ---- | ------------ | -------------------------------------------------------- |
| `GET`  | `/platform/cli/login/{session}` | none | none         | `{access_token, public_key, nonce}` (for automated flow) |

## Environment Variables

| Variable                | Purpose                                          | Required?                                         |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | token provided via env (bypass interactive flow) | no (falls back to `--token` flag or browser flow) |

## Exit Codes

| Code | Condition                                                       |
| ---- | --------------------------------------------------------------- |
| `0`  | success — token saved                                           |
| `1`  | non-TTY environment with no `--token` flag and no piped stdin   |
| `1`  | invalid token format (must be `sbp_*`)                          |
| `1`  | automated browser flow: API polling failure or decryption error |

## Output

### `--output-format text` (Go CLI compatible)

On success, prints the browser URL for the automated login flow (if TTY) or a confirmation message after token is saved.

```
Hello from Supabase! Press Enter to open browser and login...
<browser URL>
Token saved successfully.
```

For `--token` flag flow, prints a success confirmation to stdout.

### `--output-format json`

Not applicable — login is an interactive command. No machine-readable JSON output defined.

### `--output-format stream-json`

Not applicable — login is an interactive command.

## Notes

- In TTY mode without `--token`, the command opens a browser and polls the Supabase platform for a session token.
- In non-TTY mode (CI), the command requires `--token` or piped stdin. Otherwise it fails with `ErrMissingToken`.
- The `--name` flag overrides the token name used for keyring storage.
- The `--no-browser` flag skips automatic browser opening even in TTY mode.
- Token is stored in the OS keyring when available; falls back to `~/.supabase/access-token`.
- The `PostRunE` hook saves `--profile` value via `utils.SaveProfileName` if `PROFILE` is set.

# `supabase logout`

## Files Read

| Path                       | Format                    | When                                                      |
| -------------------------- | ------------------------- | --------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when keyring is unavailable; reads stored token to delete |

## Files Written

| Path                       | Format | When                                               |
| -------------------------- | ------ | -------------------------------------------------- |
| `~/.supabase/access-token` | —      | deleted on successful logout when keyring not used |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                          | Required? |
| ----------------------- | ------------------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN` | not consumed by logout; env token is not deleted | no        |

## Exit Codes

| Code | Condition                                                    |
| ---- | ------------------------------------------------------------ |
| `0`  | success — all stored credentials deleted                     |
| `0`  | not logged in — nothing to delete, exits cleanly             |
| `1`  | user cancels the confirmation prompt (`context.Canceled`)    |
| `1`  | failure to delete credential file (e.g. `$HOME` not defined) |

## Output

### `--output-format text` (Go CLI compatible)

Prints a confirmation prompt to stdout. On success, prints a logout confirmation.

```
Do you want to log out? [Y/n]
Finished supabase logout.
```

### `--output-format json`

Not applicable — logout is an interactive confirmation command. No machine-readable JSON output defined.

### `--output-format stream-json`

Not applicable — logout is an interactive confirmation command.

## Notes

- Removes all Supabase CLI credentials: the access token and any stored project database passwords.
- The command prompts for confirmation before deleting credentials (even in non-TTY mode if stdin is connected).
- If keyring reports `ErrUnsupportedPlatform`, falls back to deleting `~/.supabase/access-token` file.
- `SUPABASE_ACCESS_TOKEN` env var is not affected by logout (it is not written to disk by the CLI).

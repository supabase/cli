# `supabase backups restore`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                               | Auth         | Request body                         | Response (used fields) |
| ------ | -------------------------------------------------- | ------------ | ------------------------------------ | ---------------------- |
| `POST` | `/v1/projects/{ref}/database/backups/restore-pitr` | Bearer token | `{recovery_time_target_unix: int64}` | none (201 Created)     |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                                   |
| ---- | ----------------------------------------------------------- |
| `0`  | success — restore initiated                                 |
| `1`  | authentication error — no valid token found                 |
| `1`  | missing `--project-ref` and no linked project               |
| `1`  | API error — non-2xx response from the restore-pitr endpoint |
| `1`  | network / connection failure                                |

## Output

### `--output-format text` (Go CLI compatible)

Prints a confirmation message on success. No table output.

### `--output-format json`

No structured JSON output (command is action-only).

### `--output-format stream-json`

One `result` event on success.

## Notes

- `--timestamp` / `-t` accepts seconds since Unix epoch (int64). Defaults to `0`.
- Requires `--project-ref` or a linked project.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary via `LegacyGoProxy`.

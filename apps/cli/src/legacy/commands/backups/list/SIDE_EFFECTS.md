# `supabase backups list`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                  | Auth         | Request body | Response (used fields)                                                                       |
| ------ | ------------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/database/backups` | Bearer token | none         | `{region, walg_enabled, pitr_enabled, backups: [{inserted_at, status, is_physical_backup}]}` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                              |
| ---- | ------------------------------------------------------ |
| `0`  | success — backup list printed to stdout                |
| `1`  | authentication error — no valid token found            |
| `1`  | missing `--project-ref` and no linked project          |
| `1`  | API error — non-2xx response from the backups endpoint |
| `1`  | network / connection failure                           |

## Output

### `--output-format text` (Go CLI compatible)

For PITR-enabled projects, prints a table with columns: `REGION`, `WALG`, `PITR`, `EARLIEST TIMESTAMP`, `LATEST TIMESTAMP`.

For projects with physical backups, prints a table with columns: `REGION`, `BACKUP TYPE`, `STATUS`, `CREATED AT (UTC)`.

### `--output-format json`

Single JSON object with the full backup response as returned by the Management API.

### `--output-format stream-json`

One `result` event on success containing the backup response object.

## Notes

- Requires `--project-ref` or a linked project (resolved from `.supabase/config.json`).
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary via `LegacyGoProxy`.

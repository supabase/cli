# `supabase inspect report`

## Files Read

| Path                              | Format                    | When                                                       |
| --------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/.supabase/config.json` | JSON                      | always, to resolve linked project ref                      |

## Files Written

| Path                              | Format | When                                   |
| --------------------------------- | ------ | -------------------------------------- |
| `<output-dir>/<date>/<query>.csv` | CSV    | always, one CSV file per inspect query |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

Queries are run directly against the Postgres database (not via Management API).

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                     |
| ---- | --------------------------------------------- |
| `0`  | success — CSV files written to output-dir     |
| `1`  | database connection failure                   |
| `1`  | missing `--project-ref` and no linked project |
| `1`  | output directory not writable                 |

## Output

### `--output-format text` (Go CLI compatible)

Runs all inspect queries against the linked (or local) Postgres database and writes
one CSV file per query into `<output-dir>/<YYYY-MM-DD>/`. No output to stdout on success.

### `--output-format json`

Not applicable — this command writes CSV files, not JSON.

### `--output-format stream-json`

Not applicable — this command writes CSV files, not streamed JSON events.

## Notes

- The `--output-dir` flag (default `.`) specifies where CSV files are written.
- Queries the Postgres database directly using `--db-url`, `--linked` (default), or `--local`.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary via `LegacyGoProxy`.

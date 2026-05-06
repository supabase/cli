# `supabase inspect db cache-hit`

## Files Read

| Path                              | Format                    | When                                                       |
| --------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/.supabase/config.json` | JSON                      | always, to resolve linked project ref                      |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

Queries are run directly against the Postgres database (not via Management API).

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                     |
| ---- | --------------------------------------------- |
| `0`  | success — query results printed to stdout     |
| `1`  | database connection failure                   |
| `1`  | missing `--project-ref` and no linked project |

## Output

### `--output-format text` (Go CLI compatible)

Deprecated. Delegates to `db-stats` internally. Prints cache hit rates for tables and indices.

## Notes

- Deprecated: use `db-stats` instead.
- Queries the Postgres database directly using `--db-url`, `--linked` (default), or `--local`.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary via `LegacyGoProxy`.

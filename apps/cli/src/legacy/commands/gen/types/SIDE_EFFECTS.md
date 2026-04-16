# `supabase gen types`

## Files Read

| Path                             | Format     | When                                                                |
| -------------------------------- | ---------- | ------------------------------------------------------------------- |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` or `--project-id` |
| `<workdir>/supabase/config.toml` | TOML       | when `--local` is specified                                         |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                  | Auth         | Request body | Response (used fields)           |
| ------ | ------------------------------------- | ------------ | ------------ | -------------------------------- |
| `GET`  | `/v1/projects/{ref}/types/typescript` | Bearer token | none         | TypeScript type definitions text |

## Environment Variables

| Variable                | Purpose                               | Required?                                               |
| ----------------------- | ------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for linked/project-id mode | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL      | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                |
| ---- | ---------------------------------------- |
| `0`  | success — types printed to stdout        |
| `1`  | no target specified (must use one flag)  |
| `1`  | API error or database connection failure |

## Output

### `--output-format text` (Go CLI compatible)

Prints generated TypeScript (or other language) type definitions to stdout.

### `--output-format json`

Not applicable.

### `--output-format stream-json`

Not applicable.

## Notes

- Exactly one of `--local`, `--linked`, `--project-id`, or `--db-url` must be specified.
- `--lang` flag accepts `typescript` (default), `go`, `swift`, or `python`.
- `--schema` / `-s` accepts a comma-separated list of schemas to include.
- `--swift-access-control` accepts `internal` (default) or `public`.
- `--postgrest-v9-compat` generates types compatible with PostgREST v9 and below (requires `--db-url`).
- `--query-timeout` sets the maximum timeout for the database query (default 15s, direct connection only).

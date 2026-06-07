# `supabase test db [path] ...`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `<workdir>/supabase/tests/*.sql` | SQL        | always (test files to run)                        |
| `~/.supabase/access-token`       | plain text | when `--linked` and `SUPABASE_ACCESS_TOKEN` unset |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                 | Required?                                               |
| ----------------------- | --------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode          | no (falls back to keyring → `~/.supabase/access-token`) |
| `DB_PASSWORD`           | password for direct database connection | no                                                      |

## Exit Codes

| Code | Condition                         |
| ---- | --------------------------------- |
| `0`  | all tests passed                  |
| `1`  | one or more tests failed          |
| `1`  | database connection failure       |
| `1`  | Docker not running or unavailable |

## Output

### `--output-format text` (Go CLI compatible)

Prints pgTAP test output to stdout, including TAP-format test results.

### `--output-format json`

Not applicable (proxied to Go binary).

### `--output-format stream-json`

Not applicable (proxied to Go binary).

## Notes

- Runs pgTAP tests on the local (default) or linked database.
- `--local` (default `true`) runs tests on the local database.
- `--linked` runs tests on the linked project database.
- `--db-url` targets a specific database URL directly.
- Phase 0 proxy: all invocations are forwarded to the bundled Go binary.

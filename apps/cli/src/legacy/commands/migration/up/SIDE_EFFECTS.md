# `supabase migration up`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `<workdir>/supabase/migrations/` | directory  | always, to read pending migration files           |
| `~/.supabase/access-token`       | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked` |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                 | Purpose                                                                           | Required?                                               |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`  | auth token for `--linked` mode                                                    | no (falls back to keyring → `~/.supabase/access-token`) |
| `DOTENV_PRIVATE_KEY[_*]` | dotenvx private key(s) to decrypt `encrypted:` `[db.vault]` secrets before upsert | no (required only if a `[db.vault]` value is encrypted) |

## Exit Codes

| Code | Condition                     |
| ---- | ----------------------------- |
| `0`  | success                       |
| `1`  | database connection failure   |
| `1`  | migration SQL execution error |

## Output

### `--output-format text` (Go CLI compatible)

Prints `Applying migration <file>...` to stderr per pending migration, then
`Local database is up to date.` to stdout. Connects, lists remote + local
migrations, computes the pending set, upserts `[db.vault]` secrets, and applies
each pending migration transactionally. Does **not** seed (matches Go `up`).

### `--output-format json`

Emits `output.success("Migrations applied", { applied: [<path>] })`.

### `--output-format stream-json`

Same structured `applied` result delivered as an NDJSON `result` event.

## Notes

- `--local` (default true), `--linked`, and `--db-url` are mutually exclusive.
- `--include-all` applies all migrations not found on the remote history table.

# `supabase migration up`

## Files Read

| Path                                   | Format     | When                                                                                            |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`       | directory  | always, to read pending migration files                                                         |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked`                                               |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked`, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

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

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | database connection failure                                              |
| `1`  | migration SQL execution error                                            |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

Prints `Applying migration <file>...` to stderr per pending migration, then
`Local database is up to date.` to stdout. Connects, lists remote + local
migrations, computes the pending set, upserts `[db.vault]` secrets, and applies
each pending migration transactionally. Does **not** seed.

### `--output-format json`

Emits `output.success("Migrations applied", { applied: [<path>] })`.

### `--output-format stream-json`

Same structured `applied` result delivered as an NDJSON `result` event.

## Notes

- `--local` (default true), `--linked`, and `--db-url` are mutually exclusive.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target).
- `--include-all` applies all migrations not found on the remote history table.
- Pipeline-incompatible statements (`CREATE [UNIQUE] INDEX CONCURRENTLY`,
  `DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`,
  `CLUSTER`, `CREATE`/`DROP DATABASE`, `CREATE`/`DROP TABLESPACE`,
  `REINDEX DATABASE`/`SYSTEM`/`SCHEMA`, `CREATE`/`DROP SUBSCRIPTION`, `DISCARD ALL`,
  `ALTER DATABASE … SET TABLESPACE`, and
  `ALTER SUBSCRIPTION … REFRESH`/`SET`/`ADD`/`DROP PUBLICATION`) run standalone outside
  the migration's transaction batch — they fail with SQLSTATE 25001 inside one. The
  history insert stays in the final batch, so a mid-file failure leaves earlier,
  already-committed batches applied with **no history row**; a re-run replays the file
  from the top. Prefer idempotent forms (`… IF NOT EXISTS`) for such statements.
  Intentional fix for supabase/cli#5139, adopted into TS in PR supabase/cli#5671
  (landed on develop as `b48fad60`).

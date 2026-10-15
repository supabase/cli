# `supabase migration up`

## Files Read

| Path                                   | Format     | When                                                                                               |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`       | directory  | always, to read pending migration files                                                            |
| `<workdir>/supabase/config.toml`       | TOML       | always, for the workspace `target` (flag > `SUPABASE_TARGET` > project `.env*` > config)           |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is linked                                        |
| `<workdir>/supabase/.temp/project-ref` | plain text | linked target, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                 | Purpose                                                                              | Required?                                               |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`  | auth token for a linked target                                                       | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_TARGET`        | workspace target (`local` or `remote`) when no selector flag is given                | no                                                      |
| `SUPABASE_YES`           | confirms a hosted run when exported in the shell (the project `.env` does not count) | no                                                      |
| `DOTENV_PRIVATE_KEY[_*]` | dotenvx private key(s) to decrypt `encrypted:` `[db.vault]` secrets before upsert    | no (required only if a `[db.vault]` value is encrypted) |

## Exit Codes

| Code | Condition                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                          |
| `1`  | database connection failure                                                                      |
| `1`  | migration SQL execution error                                                                    |
| `1`  | conflicting target selectors (see Notes)                                                         |
| `1`  | hosted target without `--yes` in a run that cannot prompt (`HostedMutationConsentRequiredError`) |
| `1`  | hosted confirmation declined (`context canceled`)                                                |

## Output

### `--output-format text`

Prints `Target: …` to stderr, then `Applying migration <file>...` per pending migration, then
`Local database is up to date.` to stdout. Connects, lists remote + local
migrations, computes the pending set, upserts `[db.vault]` secrets, and applies
each pending migration transactionally. Does **not** seed.

### `--output-format json`

Emits `output.success("Migrations applied", { applied: [<path>] })`.

### `--output-format stream-json`

Same structured `applied` result delivered as an NDJSON `result` event.

## Prompts

- A hosted target (the linked project or a non-local `--db-url`) asks once, after the pending set
  is computed and before the first SQL or vault write, listing each migration to apply and the
  vault secrets to update (default **NO**). Nothing is asked when there is nothing to apply. Only
  `--yes` or an exported `SUPABASE_YES` approves a run that cannot prompt; a piped answer and a
  `SUPABASE_YES` in the project `.env` do not. Declining exits 1 (`context canceled`).
- A local target never prompts.

## Notes

- **Target.** With no selector the command follows the workspace target: the local database, or the
  linked project when `target = "remote"` is set in `supabase/config.toml` (or `SUPABASE_TARGET=remote`
  is exported). `--local`, `--linked` and `--db-url` are mutually exclusive and `--linked=false`
  selects nothing. `--project-ref` implies `--linked` and is rejected with `--local` or `--db-url`;
  an empty `--db-url` or `--project-ref` is rejected. The resolved target is announced on stderr
  (`Target: …`) in every output format and, in JSON results, as a `target` object.
- `--include-all` applies all migrations not found on the remote history table.
- Pipeline-incompatible statements (`CREATE [UNIQUE] INDEX CONCURRENTLY`,
  `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CLUSTER`) run standalone outside
  the migration's transaction batch — they fail with SQLSTATE 25001 inside one. The
  history insert stays in the final batch, so a mid-file failure leaves earlier,
  already-committed batches applied with **no history row**; a re-run replays the file
  from the top. Prefer idempotent forms (`… IF NOT EXISTS`) for such statements.
  Intentional fix for supabase/cli#5139, adopted into TS in PR supabase/cli#5671
  (landed on develop as `b48fad60`).

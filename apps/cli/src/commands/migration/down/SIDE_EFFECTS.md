# `supabase migration down`

## Files Read

| Path                                   | Format     | When                                                                                               |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`       | directory  | always, to read migration files                                                                    |
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

Prints `Target: …` to stderr, then `Resetting database to version: <version>`, then drops every
user schema/object (the embedded `dropObjectsSql` DO-block), upserts `[db.vault]`
secrets, and re-applies local migrations `<= version` plus seed files (each gated
on `db.migrations.enabled` / `db.seed.enabled`). Nothing is written to stdout.

### `--output-format json`

Emits `output.success("Migrations reverted", { version, last })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- A hosted target (the linked project or a non-local `--db-url`) asks once, after the migrations
  to revert are known and before the first drop or write: it lists the bulleted versions and a
  yellow `WARNING:` line, then asks `Reset the database to version <version> on <target>?`
  (default **NO**). Only `--yes` or an exported `SUPABASE_YES` approves a run that cannot prompt;
  a piped answer and a `SUPABASE_YES` in the project `.env` do not. Declining exits 1
  (`context canceled`).
- A local target never prompts.

## Notes

- **Target.** With no selector the command follows the workspace target: the local database, or the
  linked project when `target = "remote"` is set in `supabase/config.toml` (or `SUPABASE_TARGET=remote`
  is exported). `--local`, `--linked` and `--db-url` are mutually exclusive and `--linked=false`
  selects nothing. `--project-ref` implies `--linked` and is rejected with `--local` or `--db-url`;
  an empty `--db-url` or `--project-ref` is rejected. The resolved target is announced on stderr
  (`Target: …`) in every output format and, in JSON results, as a `target` object.
- `--last` (default 1) resets up to the last n migration versions; must be `> 0`
  and `<` the number of applied migrations.
- Takes no positional arguments.
- Performs no best-effort migrations-catalog cache optimization.
- Dotenvx-encrypted (`encrypted:`) `[db.vault]` values are decrypted during config
  load using `DOTENV_PRIVATE_KEY[_*]`; an `encrypted:` value with no working key
  aborts the command with `failed to parse config: …`.

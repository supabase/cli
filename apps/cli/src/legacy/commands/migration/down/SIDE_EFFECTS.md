# `supabase migration down`

## Files Read

| Path                             | Format     | When                                              |
| -------------------------------- | ---------- | ------------------------------------------------- |
| `<workdir>/supabase/migrations/` | directory  | always, to read migration files                   |
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

Prints `Resetting database to version: <version>` to stderr, then drops every
user schema/object (the bundled `drop.sql` DO-block), upserts `[db.vault]`
secrets, and re-applies local migrations `<= version` plus seed files (each gated
on `db.migrations.enabled` / `db.seed.enabled`). Nothing is written to stdout.

### `--output-format json`

Emits `output.success("Migrations reverted", { version, last })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- Prompts `Do you want to revert the following migrations?` with the bulleted
  versions + a yellow `WARNING:` line (default **NO**). Declining exits non-zero
  (`context canceled`). `--yes` auto-confirms; a non-interactive / machine-output
  run takes the default (NO → cancel).

## Notes

- `--last` (default 1) resets up to the last n migration versions; must be `> 0`
  and `<` the number of applied migrations.
- `--local` (default true), `--linked`, and `--db-url` are mutually exclusive.
- Takes no positional arguments.
- Skips Go's best-effort `pgcache.TryCacheMigrationsCatalog` (documented divergence).
- Dotenvx-encrypted (`encrypted:`) `[db.vault]` values are decrypted during config
  load using `DOTENV_PRIVATE_KEY[_*]`; an `encrypted:` value with no working key
  aborts the command with `failed to parse config: …`, matching Go.

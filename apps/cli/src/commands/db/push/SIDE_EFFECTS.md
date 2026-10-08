# `supabase db push`

Applies pending local migrations (and optionally seed data and custom roles) to
the local or linked/remote Postgres database, updating configured Vault secrets
before migrations unless `--skip-vault` is set.

## Files Read

| Path                                              | Format      | When                                                                                                                                 |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.json` or `config.toml` | JSON / TOML | always; `config.json` is preferred when both exist (embedded defaults used when neither exists)                                      |
| `<workdir>/.env*`, `<workdir>/supabase/.env*`     | dotenv      | project env files, resolved with `SUPABASE_ENV` (default `development`); a variable the shell sets is never taken from a file        |
| `~/.supabase/<hash>/project-ref`                  | plain text  | on the `--linked` path (and the default target), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `~/.supabase/access-token`                        | plain text  | when `SUPABASE_ACCESS_TOKEN` unset and a linked temp-role is minted                                                                  |
| `<workdir>/supabase/migrations/`                  | directory   | when `[db.migrations].enabled` (default true), to list local files                                                                   |
| `<workdir>/supabase/migrations/*.sql`             | SQL         | for each pending migration, when applied (and not `--dry-run`)                                                                       |
| seed files from `[db.seed].sql_paths`             | SQL         | when `--include-seed` and `[db.seed].enabled` (paths under `supabase/`)                                                              |
| `<workdir>/supabase/roles.sql`                    | SQL         | when `--include-roles` (existence check + apply)                                                                                     |

## Files Written

| Path                                             | Format | When                                    |
| ------------------------------------------------ | ------ | --------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | on the `--linked` path (post-run cache) |
| `~/.supabase/telemetry.json`                     | JSON   | always (post-run telemetry flush)       |

## Database Mutations

| Statement                                                                                                           | When                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESET ALL` + migration statements + `INSERT INTO supabase_migrations.schema_migrations(version, name, statements)` | per pending migration (after confirmation); compatible statements use an implicit extended-protocol batch with one final `Sync`, while pipeline-incompatible statements run standalone — see Notes                                      |
| `CREATE SCHEMA/TABLE … supabase_migrations.schema_migrations`, `ALTER TABLE … ADD COLUMN …`                         | once before applying migrations, when a read-only probe finds the ledger not yet provisioned (idempotent; supabase/cli#6393)                                                                                                            |
| `roles.sql` statements (no history row)                                                                             | per `--include-roles` globals file (after confirmation); statements use an implicit extended-protocol batch with one final `Sync`                                                                                                       |
| `SELECT id, name FROM vault.secrets …`, `SELECT vault.update_secret(...)`, `SELECT vault.create_secret(...)`        | when `[db.vault]` has syncable secrets, migrations are applied, and `--skip-vault` is not set                                                                                                                                           |
| `CREATE TABLE … supabase_migrations.seed_files`, seed statements, `INSERT … seed_files(path, hash) … ON CONFLICT …` | per pending seed file with `--include-seed` (after confirmation; the `seed_files` DDL only when a read-only probe finds that ledger not yet provisioned); a dirty seed only refreshes the hash                                          |
| `SET SESSION ROLE postgres`                                                                                         | stepped-down sessions only (`cli_login_*`/`supabase_admin`): after each top-level role-reverting statement, at the end of each migration/globals/seed file, and before the history insert and the `seed_files` upsert (CLI-2205, #6236) |

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                                                                                                                                           |
| ------ | ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —      | —    | —    | —            | The native handler connects to Postgres directly. On the `--linked` path the db-config resolver may call the Management API to mint a temporary login role (inherited from the shared resolver). |

## Environment Variables

| Variable                      | Purpose                                                                                                                                      | Required?                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`       | auth token for the `--linked` resolver path                                                                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`        | password for the linked/remote connection; ignored for a target other than the linked project (see Notes)                                    | no (`--password`/`-p` takes precedence)                 |
| `SUPABASE_DB_SEED_ENABLED`    | overrides `[db.seed].enabled`, including a matched `[remotes.*]` block; lifts a `false` but does not make push seed without `--include-seed` | no                                                      |
| `SUPABASE_*` config overrides | any `config.toml` key an env name exists for (e.g. `SUPABASE_DB_MIGRATIONS_ENABLED`); see Notes                                              | no                                                      |
| `SUPABASE_YES`                | auto-confirm prompts                                                                                                                         | no (also `--yes`)                                       |
| `SUPABASE_PROJECT_ID`         | linked-ref resolution override, superseded by `--project-ref` when set (same precedence position) — see Notes                                | no                                                      |
| `DOTENV_PRIVATE_KEY*`         | decrypts `encrypted:` config secrets; `[db.vault]` values are not decrypted with `--skip-vault`                                              | no                                                      |

## Exit Codes

| Code | Condition                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (including "up to date")                                                                                              |
| `1`  | mutually exclusive target flags (`[db-url linked local]`)                                                                     |
| `1`  | `ErrMissingLocal` — remote versions absent locally (suggests repair/pull)                                                     |
| `1`  | `ErrMissingRemote` without `--include-all` (suggests `--include-all`)                                                         |
| `1`  | user declined a confirmation prompt (`context canceled`)                                                                      |
| `1`  | seed consent for a `[remotes.*]` match declined or unattended without `--yes` (`context canceled`, suggests `--yes`)          |
| `1`  | `--password` with `--db-url` or `--local` (`if any flags in the group [<target> password] are set none of the others can be`) |
| `1`  | an invalid config value, including an unparsable `SUPABASE_*` override                                                        |
| `1`  | `config.toml` parse failure                                                                                                   |
| `1`  | database connection / migration / seed / roles / vault apply failure                                                          |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes)                                                      |

## Output

Diagnostics ("Connecting to…", "Applying migration…", "Seeding…", "Updating vault
secrets…", skip/up-to-date notices, dry-run plan, prompts) go to **stderr**. The
two summary lines — `<Target> is up to date.` and `Finished supabase db push.`
(the command name in Aqua) — go to stdout in text mode; in machine modes they
are suppressed and a structured result is emitted.

### `--output-format text`

Connection status, per-item progress, prompts, and the stdout
summary line, including ANSI color (Aqua command name, Bold file paths).

### `--output-format json` / `stream-json`

stdout is payload-only. A single `result` object is emitted:

```json
{
  "upToDate": false,
  "dryRun": false,
  "migrations": ["<file>.sql"],
  "seeds": ["supabase/seed.sql"],
  "roles": ["supabase/roles.sql"]
}
```

## Notes

- **Targets**: `--db-url`, `--linked` (default), and `--local` are mutually
  exclusive; with no flag the target defaults to linked.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution `ProjectRefResolver`
  performs (flag > `SUPABASE_PROJECT_ID` > `~/.supabase/<hash>/project-ref`).
  It never implies `--linked`: passing it with a resolved `--local`/`--db-url`
  target is a hard error rather than a silently discarded flag (deliberately
  stricter than `SUPABASE_PROJECT_ID`, which simply goes unused on a
  non-linked target).
- **Config value precedence** (ADR 0031): explicit flag > shell env > project
  `.env*` > config (`config.json` over `config.toml`; a matched `[remotes.*]`
  block over the base document) > default. The whole config is decoded up
  front, so an invalid value fails the command before any connection.
- **Credential scoping**: the linked-database password env (`SUPABASE_DB_PASSWORD`)
  is withheld when the target project differs from the one in
  `.temp/project-ref`. The command prints `WARN: ignoring SUPABASE_DB_PASSWORD because this directory is linked to project <linked>, not <target>. Pass --password to use a database password for <target>.` to stderr and mints a
  temporary login role instead. Unlinked workdirs use the env value.
- **`--password`** is rejected with `--db-url` or `--local`, because those
  targets carry their own credentials.
- **Seed consent**: when a `--linked`/`--project-ref` target matches a
  `[remotes.<name>]` block and there are seeds to apply, the command asks
  `The target matched [remotes.<name>]. Seed data into this database?`
  (default no) before the roles prompt. `--yes`/`SUPABASE_YES` answers yes.
  With a TTY stdin and non-interactive output it declines without prompting;
  with piped stdin it reads one line and an empty answer declines. A decline
  exits 1. Not asked on `--dry-run`.
- **Seeding** still requires `--include-seed`. A matched remote that does not
  declare `db.seed.enabled` seeds nothing; `--include-seed` or
  `SUPABASE_DB_SEED_ENABLED=true` lifts that, but env alone does not make push
  seed.
- **Prompt order**: seed consent (matched remote only) → custom roles →
  migrations → seeds; each defaults to "yes" and declining returns `context canceled`.
- **`--dry-run`** prints the plan (roles / migrations / seeds) and applies nothing.
- **`[db.migrations].enabled = false`** / **`[db.seed].enabled = false`** print a
  skip notice naming the project ref (empty for local/db-url).
- **Vault**: non-empty, non-`env()` `[db.vault]` values are synced after config
  load, including decrypted `encrypted:` values. `--skip-vault` leaves them unchanged
  and does not resolve or decrypt their configured values.
- **Pipeline-incompatible statements**: `CREATE [UNIQUE] INDEX CONCURRENTLY`,
  `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, and `CLUSTER` cannot run inside a
  transaction block (SQLSTATE 25001). The apply flushes (commits) the open batch, runs
  the statement standalone outside any transaction, then resumes batching; the history
  insert stays in the final batch so the migration is recorded only after every
  statement succeeds. Atomicity is therefore lost at each flush boundary: statements
  committed in an earlier batch are **not** rolled back if a later statement fails,
  leaving the database partially migrated with **no history row** — a re-run replays
  the whole file from the top (which may then fail on already-applied statements).
  Prefer idempotent forms (`CREATE INDEX CONCURRENTLY IF NOT EXISTS …`) and isolating
  such statements in their own migration file. Intentional fix for supabase/cli#5139,
  adopted into TS in PR supabase/cli#5671 (landed on develop as `b48fad60`).

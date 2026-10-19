# `supabase db push`

Applies pending local migrations (and optionally seed data and custom roles) to
the local database by default, or to the database `--remote` selects (the linked project,
`--remote=<ref>`, a branch via `--remote=<branch>`, or a database via `--remote=<url>`),
updating configured Vault secrets before migrations unless `--skip-vault`
is set. A hosted target asks one combined confirmation before the first write. With no
selector in a linked checkout, the `Target:` line adds `default; pass --remote for <project>`.

## Files Read

| Path                                              | Format      | When                                                                                                                                              |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json` or `config.toml` | JSON / TOML | always; `config.json` is preferred when both exist (embedded defaults used when neither exists)                                                   |
| `<workdir>/.env*`, `<workdir>/supabase/.env*`     | dotenv      | project env files, resolved with `SUPABASE_ENV` (default `development`); a variable the shell sets is never taken from a file                     |
| `~/.supabase/<hash>/project-ref`                  | plain text  | bare `--remote`, to resolve the ref — skipped when `SUPABASE_PROJECT_ID` is set; with no selector, only to name the project in the `Target:` hint |
| `~/.supabase/access-token`                        | plain text  | when `SUPABASE_ACCESS_TOKEN` unset and a remote temp-role is minted                                                                               |
| `<workdir>/supabase/migrations/`                  | directory   | when `[db.migrations].enabled` (default true), to list local files                                                                                |
| `<workdir>/supabase/migrations/*.sql`             | SQL         | for each pending migration, when applied (and not `--dry-run`)                                                                                    |
| seed files from `[db.seed].sql_paths`             | SQL         | when `--include-seed` and `[db.seed].enabled` (paths under `supabase/`)                                                                           |
| `<workdir>/supabase/roles.sql`                    | SQL         | when `--include-roles` (existence check + apply)                                                                                                  |

## Files Written

| Path                                             | Format | When                                           |
| ------------------------------------------------ | ------ | ---------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | on a remote project or branch (post-run cache) |
| `~/.supabase/telemetry.json`                     | JSON   | always (post-run telemetry flush)              |

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

| Method | Path | Auth | Request body | Response (used fields)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —      | —    | —    | —            | The native handler connects to Postgres directly. On a remote project or branch the db-config resolver may call the Management API to mint a temporary login role (inherited from the shared resolver), and `--remote=<branch>` (or a bare `--remote` followed by a word that could name a branch) calls `GET /v1/projects/{parent}/branches` to find the branch's project (`{parent}` is `SUPABASE_PROJECT_ID`, else the linked project). |

## Environment Variables

| Variable                      | Purpose                                                                                                                                               | Required?                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`       | auth token for a remote project or branch                                                                                                             | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`        | password for the remote connection; ignored for a target other than the linked project (see Notes)                                                    | no (`--password`/`-p` takes precedence)                 |
| `SUPABASE_DB_SEED_ENABLED`    | overrides `[db.seed].enabled`, including a matched `[remotes.*]` block; lifts a `false` but does not make push seed without `--include-seed`          | no                                                      |
| `SUPABASE_*` config overrides | any `config.toml` key an env name exists for (e.g. `SUPABASE_DB_MIGRATIONS_ENABLED`); see Notes                                                       | no                                                      |
| `SUPABASE_YES`                | shell value confirms the hosted-mutation consent and lets the connection clear a network ban; a `SUPABASE_YES` in `supabase/.env` does not            | no (also `--yes`)                                       |
| `SUPABASE_PROJECT_ID`         | linked-ref resolution override, superseded by `--remote=<ref>` when set, and the parent project that `--remote=<branch>` resolves against — see Notes | no                                                      |
| `DOTENV_PRIVATE_KEY*`         | decrypts `encrypted:` config secrets; `[db.vault]` values are not decrypted with `--skip-vault`                                                       | no                                                      |

## Exit Codes

| Code | Condition                                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (including "up to date")                                                                                                                                                                                        |
| `1`  | more than one of `--remote`, `--linked`, `--db-url` and `--local`, or `--project-ref` with `--local`/`--db-url`/`--remote=<value>` (target selector conflict)                                                           |
| `1`  | `--remote=<branch>` naming no branch of the parent project                                                                                                                                                              |
| `1`  | `ErrMissingLocal` — remote versions absent locally (suggests repair/pull)                                                                                                                                               |
| `1`  | `ErrMissingRemote` without `--include-all` (suggests `--include-all`)                                                                                                                                                   |
| `1`  | the combined confirmation declined at the prompt (`HostedMutationDeclinedError`); nothing is written                                                                                                                    |
| `1`  | the combined confirmation needed but the run can't prompt (JSON or machine output, piped stdin, agent) and neither `--yes` nor a shell `SUPABASE_YES` is set (`HostedMutationConsentRequiredError`); nothing is written |
| `1`  | `--password` with `--remote=<url>` or the local default (`--password can't be used with --remote=<db-url>. …` / `--password only applies to a linked project. …`)                                                       |
| `1`  | an invalid config value, including an unparsable `SUPABASE_*` override                                                                                                                                                  |
| `1`  | `config.toml` parse failure                                                                                                                                                                                             |
| `1`  | database connection / migration / seed / roles / vault apply failure                                                                                                                                                    |

## Output

Diagnostics (alias deprecation warnings, the `Target: …` banner, "Applying migration…", "Seeding…", "Updating vault
secrets…", skip/up-to-date notices, dry-run plan, the confirmation) go to **stderr**. The
two summary lines — `<Target> is up to date.` and `Finished supabase db push.`
(the command name in Aqua) — go to stdout in text mode; in machine modes they
are suppressed and a structured result is emitted.

### `--output-format text`

The `Target:` banner, per-item progress, the confirmation, and the stdout
summary line, including ANSI color (Aqua command name, Bold file paths).

### `--output-format json` / `stream-json`

stdout is payload-only. A single `result` object is emitted:

```json
{
  "upToDate": false,
  "dryRun": false,
  "migrations": ["<file>.sql"],
  "seeds": ["supabase/seed.sql"],
  "roles": ["supabase/roles.sql"],
  "target": { "kind": "linked", "project_ref": "<ref>", "environment": "production" }
}
```

`target` is the announced target (a remote project or branch as `linked`, `local`, or `db-url`); the linked shape carries the
project ref and its environment.

## Notes

- **Targets**: with no selector the target is the local database. The target is announced as a
  `Target:` banner on stderr before anything is connected.
- **Target selection.** `--remote` is read as the linked project (bare), a project ref (20
  lowercase letters), a Postgres URL, or else a branch of the linked project by name or UUID;
  `--remote=false` and `--remote=` fail with `Leave out --remote to target the local database.` A
  bare `--remote` followed by a word that is a branch of the linked project fails with a
  `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- **Deprecated aliases.** `--linked`, `--project-ref=<ref>`, `--db-url=<url>` and `--local` still
  work and print a deprecation warning on stderr naming the `--remote` replacement (`--local`
  warns that local is the default). They are mutually exclusive with each other and with
  `--remote`; a `false` switch counts as absent. `--project-ref` with `--local`, `--db-url` or
  `--remote=<value>` is a hard error.
- **Config value precedence** (ADR 0032): explicit flag > shell env > project
  `.env*` > config (`config.json` over `config.toml`; a matched `[remotes.*]`
  block over the base document) > default. The whole config is decoded up
  front, so an invalid value fails the command before any connection.
- **Credential scoping**: the linked-database password env (`SUPABASE_DB_PASSWORD`)
  is withheld when the target project differs from the one in
  `.temp/project-ref`. The command prints `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.` to stderr and mints a
  temporary login role instead. Unlinked workdirs use the env value.
- **`--password`** is rejected with `--remote=<url>` and for the local default, because those
  targets carry their own credentials.
- **One combined confirmation**: after the plan is known and before the first write, a hosted
  target asks once, for everything the run will do — custom roles, migrations, vault secrets,
  seed files — e.g. `Create custom roles, apply 1 migration and seed 1 file?`, listing each
  item. The default is No; declining exits 1 with nothing written. The local default and
  `--dry-run` ask nothing, and neither does a run that finds nothing to apply. JSON or machine
  output, piped stdin and agent runs never prompt; they need `--yes` or a shell
  `SUPABASE_YES`, which echoes `Confirmed by --yes: <action>` to stderr. A `SUPABASE_YES` in
  `supabase/.env` is not consent. The same approval lets the connection remove a network ban
  that blocks the temporary login role; without it the run fails and suggests
  `supabase network-bans remove`.
- **Seeding** requires `--include-seed`; `SUPABASE_DB_SEED_ENABLED=true` alone
  does not make push seed. `--include-seed` beats `[db.seed] enabled = false`
  in the base config. When the target matches a `[remotes.<name>]` block that does not
  declare `db.seed.enabled = true` itself, the confirmation names that block and the
  setting that enabled seeding (`seed 1 file into [remotes.<name>] (seeding enabled by
<origin>)`).
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

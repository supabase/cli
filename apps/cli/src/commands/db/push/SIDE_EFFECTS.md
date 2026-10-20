# `supabase db push`

Applies pending local migrations (and optionally seed data and custom roles) to
the local or linked/remote Postgres database, updating configured Vault secrets
before migrations unless `--skip-vault` is set.

## Files Read

| Path                                  | Format     | When                                                                                                                                 |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`      | TOML       | always (embedded defaults used when absent)                                                                                          |
| `~/.supabase/<hash>/project-ref`      | plain text | on the `--linked` path (and the default target), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |
| `~/.supabase/access-token`            | plain text | when `SUPABASE_ACCESS_TOKEN` unset and a linked temp-role is minted                                                                  |
| `<workdir>/supabase/migrations/`      | directory  | when `[db.migrations].enabled` (default true), to list local files                                                                   |
| `<workdir>/supabase/migrations/*.sql` | SQL        | for each pending migration, when applied (and not `--dry-run`)                                                                       |
| seed files from `[db.seed].sql_paths` | SQL        | when `--include-seed` and `[db.seed].enabled` (paths under `supabase/`)                                                              |
| `<workdir>/supabase/roles.sql`        | SQL        | when `--include-roles` (existence check + apply)                                                                                     |
| `PGSSL*` PEM, `pg_service.conf`       | PEM, libpq | `--db-url` or the linked project, when the DSN or env sets them; no PEM file is read under `sslmode=disable` (see Notes)             |
| `.pgpass` (`pgpass.conf` on Windows)  | libpq      | `--db-url` with no password, or the linked pooler route (password discarded); `PGPASSFILE` overrides the path (see Notes)            |

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

| Variable                                 | Purpose                                                                                                                                                                                                                                    | Required?                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                  | auth token for the `--linked` resolver path                                                                                                                                                                                                | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`                   | password for the linked/remote connection                                                                                                                                                                                                  | no (`--password`/`-p` takes precedence)                 |
| `SUPABASE_YES`                           | auto-confirm prompts                                                                                                                                                                                                                       | no (also `--yes`)                                       |
| `SUPABASE_PROJECT_ID`                    | linked-ref resolution override, superseded by `--project-ref` when set (same precedence position) — see Notes                                                                                                                              | no                                                      |
| `DOTENV_PRIVATE_KEY*`                    | decrypts `encrypted:` config secrets; `[db.vault]` values are not decrypted with `--skip-vault`                                                                                                                                            | no                                                      |
| `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION` | deprecated alias of `SUPABASE_DB_ORIOLEDB_VERSION`, used only while that is unset; when set, stderr gets `WARN: SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION is deprecated and will be removed in v3, use SUPABASE_DB_ORIOLEDB_VERSION instead.` | no                                                      |
| `PG*` libpq                              | linked project, shell only: `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`/`PGSSLKEY`/`PGSSLPASSWORD`, `PGCONNECT_TIMEOUT`, `PGSERVICE`/`PGSERVICEFILE`; `--db-url`: any `PG*` the DSN omits, shell first, then project `.env*` (see Notes)     | no                                                      |

## Exit Codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | success (including "up to date")                                          |
| `1`  | mutually exclusive target flags (`[db-url linked local]`)                 |
| `1`  | `ErrMissingLocal` — remote versions absent locally (suggests repair/pull) |
| `1`  | `ErrMissingRemote` without `--include-all` (suggests `--include-all`)     |
| `1`  | user declined a confirmation prompt (`context canceled`)                  |
| `1`  | `config.toml` parse failure                                               |
| `1`  | database connection / migration / seed / roles / vault apply failure      |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes)  |

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

### Target default warning

A run that passes none of `--local`, `--linked`, `--db-url` or `--project-ref` (in any form, including `--linked=false`) writes one line to **stderr** before the target is resolved, in every `--output-format`, when a linked project ref is configured (from `SUPABASE_PROJECT_ID` or the link file). An unlinked run prints only the existing not-linked error. stdout is unchanged. The next major version targets the local database by default.

```
Warning: supabase db push will target the local database by default in the next major version. Pass --linked to keep targeting the linked project.
```

## Notes

- **Targets**: `--db-url`, `--linked` (default), and `--local` are mutually
  exclusive; with no flag the target defaults to linked.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution `RemoteTarget`
  performs (flag > `SUPABASE_PROJECT_ID` > `~/.supabase/<hash>/project-ref`).
  It never implies `--linked`: passing it with a resolved `--local`/`--db-url`
  target is a hard error rather than a silently discarded flag (deliberately
  stricter than `SUPABASE_PROJECT_ID`, which simply goes unused on a
  non-linked target).
- **Prompt order**: custom roles → migrations → seeds; each defaults to "yes" and
  declining returns `context canceled`.
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
- **Linked libpq env.** On every linked database connection, `PGSSLMODE`, `PGSSLROOTCERT`,
  `PGSSLCERT`/`PGSSLKEY`/`PGSSLPASSWORD`, `PGCONNECT_TIMEOUT`, and `PGSERVICE`/`PGSERVICEFILE` are
  read from the shell only, never the project `.env*` (`gen types` keeps its pinned mode and CA,
  except on the pooler temp-role probe), on the direct host and the IPv4 pooler alike; host, port,
  role, and database stay pinned. As in libpq, a `PGSERVICE` entry's settings outrank these vars.
  An invalid mode or `PGCONNECT_TIMEOUT`, an unknown `PGSERVICE`, or a lone `PGSSLCERT`/`PGSSLKEY`
  outside `sslmode=disable` fails with `invalid libpq environment` on either route.
  `sslmode=disable` dials plaintext and reads no CA or client-cert file; otherwise those PEM files
  are read when set and a missing one fails the connection, and a `pg_service.conf` is read
  whenever `PGSERVICE` names a service. The pooler route also reads `.pgpass` (`PGPASSFILE`, else
  `~/.pgpass`, or `%APPDATA%\postgresql\pgpass.conf` on Windows) and discards that password, and
  it keeps `PGAPPNAME` and a service's `options` and runtime keys, which the direct host drops.
  Tool containers get none of these `PG*` TLS settings (migra gets the CLI's own bundled CA
  outside its OOM fallback); migra and pgadmin get the timeout as `connect_timeout` and the
  pooler's `options` and runtime keys in their URL.

# `supabase db push`

Native TypeScript port of `apps/cli-go/internal/db/push/push.go`. Applies pending
local migrations (and optionally seed data and custom roles) to the local or
linked/remote Postgres database.

## Files Read

| Path                                  | Format     | When                                                                    |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`      | TOML       | always (embedded defaults used when absent)                             |
| `~/.supabase/<hash>/project-ref`      | plain text | on the `--linked` path (and the default target), to resolve the ref     |
| `~/.supabase/access-token`            | plain text | when `SUPABASE_ACCESS_TOKEN` unset and a linked temp-role is minted     |
| `<workdir>/supabase/migrations/`      | directory  | when `[db.migrations].enabled` (default true), to list local files      |
| `<workdir>/supabase/migrations/*.sql` | SQL        | for each pending migration, when applied (and not `--dry-run`)          |
| seed files from `[db.seed].sql_paths` | SQL        | when `--include-seed` and `[db.seed].enabled` (paths under `supabase/`) |
| `<workdir>/supabase/roles.sql`        | SQL        | when `--include-roles` (existence check + apply)                        |

## Files Written

| Path                                                                            | Format | When                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json`                                | JSON   | on the `--linked` path (post-run cache, Go's `ensureProjectGroupsCached`)                                                                                                                                                                            |
| `~/.supabase/telemetry.json`                                                    | JSON   | always (post-run telemetry flush)                                                                                                                                                                                                                    |
| `<workdir>/supabase/.temp/pgdelta/catalog-<prefix>-migrations-<hash>-<ts>.json` | JSON   | best-effort, after a successful migration apply, when pg-delta is enabled (`[experimental.pgdelta] enabled` or `SUPABASE_EXPERIMENTAL_PG_DELTA`); a failure only warns on stderr and never fails the push (Go's `pgcache.TryCacheMigrationsCatalog`) |
| `<workdir>/supabase/.temp/pgdelta/pgdelta-target-ca.crt`                        | PEM    | same gate as above, when the target requires SSL (`legacyPreparePgDeltaRef`)                                                                                                                                                                         |

## Database Mutations

| Statement                                                                                                                                | When                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `RESET ALL` + `BEGIN` … migration statements … `INSERT INTO supabase_migrations.schema_migrations(version, name, statements)` … `COMMIT` | per pending migration (after confirmation); pipeline-incompatible statements run standalone between batches — see Notes |
| `CREATE SCHEMA/TABLE … supabase_migrations.schema_migrations`, `ALTER TABLE … ADD COLUMN …`                                              | once before applying migrations (idempotent)                                                                            |
| `RESET ALL` + `BEGIN` … roles.sql statements … `COMMIT` (no history row)                                                                 | per `--include-roles` globals file (after confirmation)                                                                 |
| `SELECT id, name FROM vault.secrets …`, `SELECT vault.update_secret(...)`, `SELECT vault.create_secret(...)`                             | when `[db.vault]` has syncable secrets and migrations are applied                                                       |
| `CREATE TABLE … supabase_migrations.seed_files`, seed statements, `INSERT … seed_files(path, hash) … ON CONFLICT …`                      | per pending seed file with `--include-seed` (after confirmation); a dirty seed only refreshes the hash                  |

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                                                                                                                                           |
| ------ | ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —      | —    | —    | —            | The native handler connects to Postgres directly. On the `--linked` path the db-config resolver may call the Management API to mint a temporary login role (inherited from the shared resolver). |

## Environment Variables

| Variable                           | Purpose                                                                                                          | Required?                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`            | auth token for the `--linked` resolver path                                                                      | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`             | password for the linked/remote connection                                                                        | no (`--password`/`-p` takes precedence)                 |
| `SUPABASE_YES`                     | auto-confirm prompts (Go's `viper YES`)                                                                          | no (also `--yes`)                                       |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`   | enables the migrations-catalog cache when `[experimental.pgdelta].enabled` is unset                              | no (project `.env` or shell)                            |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | overrides the pg-delta edge-runtime image registry for the cache export                                          | no (project `.env` or shell)                            |
| `PGDELTA_NPM_REGISTRY`             | overrides the pg-delta edge-runtime npm registry (`.npmrc` + `NPM_CONFIG_REGISTRY` forward) for the cache export | no (project `.env` or shell)                            |

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

## Output

Diagnostics ("Connecting to…", "Applying migration…", "Seeding…", "Updating vault
secrets…", skip/up-to-date notices, dry-run plan, prompts) go to **stderr**. The
two summary lines Go prints to **stdout** — `<Target> is up to date.` and
`Finished supabase db push.` (the command name in Aqua) — go to stdout in text
mode; in machine modes they are suppressed and a structured result is emitted.

### `--output-format text` (Go CLI compatible)

Byte-matches Go: connection status, per-item progress, prompts, and the stdout
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
  exclusive; with no flag the target defaults to linked, matching Go.
- **Prompt order**: custom roles → migrations → seeds; each defaults to "yes" and
  declining returns `context canceled`.
- **`--dry-run`** prints the plan (roles / migrations / seeds) and applies nothing.
- **`[db.migrations].enabled = false`** / **`[db.seed].enabled = false`** print a
  skip notice naming the project ref (empty for local/db-url).
- **Vault**: non-empty, non-`env()` `[db.vault]` values are synced after config
  load, including decrypted `encrypted:` values.
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
  such statements in their own migration file. Intentional fix for supabase/cli#5139:
  the reference design is the **closed, unmerged** Go PR supabase/cli#5156, adopted
  directly into TS in PR supabase/cli#5671 (landed on develop as `b48fad60`) and
  back-ported to the pinned `apps/cli-go` oracle under the CLI-1989 parity ruling
  (2026-07-30).
- **Migrations catalog cache**: ported (Go's best-effort `pgcache.TryCacheMigrationsCatalog`).
  After a successful migration apply, when pg-delta is enabled, exports the target's
  pg-delta catalog via the edge-runtime stack and writes it under
  `supabase/.temp/pgdelta/`, pruning older snapshots for the same prefix (retains 2).
  A failure only warns on stderr (`Warning: failed to cache migrations catalog: …`)
  and never fails the push, matching Go exactly. Reuses `legacyExportCatalogPgDelta`
  (the same pg-delta export path `db pull`/`db diff` use, which always mounts the
  project root at `/workspace`) rather than a second copy, so the ENOENT bug fixed in
  Go's `pgcache/cache.go` (supabase/cli#5921) has no TS equivalent.

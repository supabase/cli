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

| Path                                             | Format | When                                                                      |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | on the `--linked` path (post-run cache, Go's `ensureProjectGroupsCached`) |
| `~/.supabase/telemetry.json`                     | JSON   | always (post-run telemetry flush)                                         |

No project files are written. All other effects are database mutations (below).

## Database Mutations

| Statement                                                                                                                                | When                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `RESET ALL` + `BEGIN` … migration statements … `INSERT INTO supabase_migrations.schema_migrations(version, name, statements)` … `COMMIT` | per pending migration (after confirmation)                                                             |
| `CREATE SCHEMA/TABLE … supabase_migrations.schema_migrations`, `ALTER TABLE … ADD COLUMN …`                                              | once before applying migrations (idempotent)                                                           |
| `RESET ALL` + `BEGIN` … roles.sql statements … `COMMIT` (no history row)                                                                 | per `--include-roles` globals file (after confirmation)                                                |
| `SELECT id, name FROM vault.secrets …`, `SELECT vault.update_secret(...)`, `SELECT vault.create_secret(...)`                             | when `[db.vault]` has syncable secrets and migrations are applied                                      |
| `CREATE TABLE … supabase_migrations.seed_files`, seed statements, `INSERT … seed_files(path, hash) … ON CONFLICT …`                      | per pending seed file with `--include-seed` (after confirmation); a dirty seed only refreshes the hash |

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                                                                                                                                           |
| ------ | ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —      | —    | —    | —            | The native handler connects to Postgres directly. On the `--linked` path the db-config resolver may call the Management API to mint a temporary login role (inherited from the shared resolver). |

## Environment Variables

| Variable                | Purpose                                     | Required?                                               |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for the `--linked` resolver path | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the linked/remote connection   | no (`--password`/`-p` takes precedence)                 |
| `SUPABASE_YES`          | auto-confirm prompts (Go's `viper YES`)     | no (also `--yes`)                                       |

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
- **Vault**: only non-empty, non-`env()` `[db.vault]` literals are synced (Go syncs
  secrets with a non-empty SHA256). **Known gap vs Go**: `encrypted:`-prefixed
  vault secrets are currently skipped — dotenvx/ECIES decryption is not yet ported.
- **Migrations catalog cache** (Go's best-effort `pgcache.TryCacheMigrationsCatalog`,
  warning-only) is not ported; it produces no output, so parity is preserved.

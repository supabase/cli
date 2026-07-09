# `supabase db reset`

Native TypeScript port of `apps/cli-go/internal/db/reset/reset.go`. Reinitialises a
database from local migrations (plus seed). The **remote** path (`--linked`, or a
remote `--db-url`) is native: drop all user schemas, upsert vault secrets, then
re-apply migrations and seed. The **local** path (`--local`/default, or a `--db-url`
pointing at the local stack) is also native: TS orchestrates the running check,
messages, bucket seeding, and git-branch line, while the container-recreate
primitives run behind the hidden Go `db __db-bootstrap` seam. Only the niche
**`--experimental`** remote schema-files path still delegates to the Go binary.

## Files Read

| Path                                                   | Format     | When                                                                                                                  |
| ------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`                       | directory  | to validate `--version` / resolve `--last`, and to load migrations                                                    |
| `<workdir>/supabase/config.toml`                       | TOML       | always, parsed up front before any destructive work (embedded defaults when absent); re-read for local bucket seeding |
| `<workdir>/.git/HEAD` (walked upward)                  | plain text | local path, for the `Finished … on branch <branch>.` line                                                             |
| `~/.supabase/<hash>/project-ref`                       | plain text | `--linked`, to resolve the ref                                                                                        |
| `~/.supabase/access-token`                             | plain text | `--linked`, when `SUPABASE_ACCESS_TOKEN` unset and a temp role is minted                                              |
| seed files from `--sql-paths` or `[db.seed].sql_paths` | SQL        | when seeding is enabled (not `--no-seed`); `--sql-paths` overrides config                                             |
| `<workdir>/supabase/buckets/`                          | files      | local path, when storage is up and `[storage.buckets]` configure objects                                              |

## Files Written

| Path                                             | Format | When                              |
| ------------------------------------------------ | ------ | --------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | `--linked` (post-run cache)       |
| `~/.supabase/telemetry.json`                     | JSON   | always (post-run telemetry flush) |

On the local path the Go seam additionally recreates the `supabase_db_<project>`
container/volume and applies the initial schema (`SetupLocalDatabase`); the
`--experimental` remote path produces whatever the delegated Go binary writes.

## Subprocesses

| Command                                                                     | When                                | Purpose                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `docker container inspect supabase_db_<project>`                            | local path                          | `AssertSupabaseDbIsRunning` probe (Podman fallback)                     |
| `supabase-go db __db-bootstrap --mode recreate [--version <v>] [--no-seed]` | local path                          | recreate container + init schema + migrate + seed + restart services    |
| `supabase-go db __db-bootstrap --mode await-storage`                        | local path                          | storage health gate before bucket seeding (`ready` / `absent`)          |
| `supabase-go db reset --linked\|--db-url … [--no-seed]`                     | `--experimental` remote, no version | the un-ported experimental schema-files apply path (telemetry disabled) |

The seam subprocesses run with `SUPABASE_TELEMETRY_DISABLED=1`, stderr inherited;
`--network-id` / a flag-selected `--profile` are forwarded.

## Database Mutations

### Remote path (native, in TS)

| Statement                                                                                       | When                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `drop.sql` `DO` block (drops user schemas/extensions/public objects, truncates auth/migrations) | always, first                                                |
| `SELECT vault.update_secret(...)` / `vault.create_secret(...)`                                  | when `[db.vault]` has syncable secrets                       |
| migration statements + `schema_migrations` history insert (per file, transactional)             | when `[db.migrations].enabled`, for migrations `≤ --version` |
| seed statements + `seed_files` hash upsert                                                      | when `[db.seed].enabled` and not `--no-seed`                 |

### Local path (inside the Go seam)

The recreate seam drops & recreates the `postgres`/`_supabase` databases (PG≤14) or
removes & recreates the db container/volume (PG15), applies the initial schema +
roles, then runs `MigrateAndSeed` (migrations `≤ --version`, seed unless `--no-seed`)
and restarts the storage/auth/realtime/pooler containers. Bucket objects are then
seeded over the Storage gateway (reusing the `seed buckets` local path).

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                                                                                                             |
| ------ | ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —      | —    | —    | —            | Connects to Postgres directly. The `--linked` resolver may call the Management API to mint a temporary login role; local bucket seeding calls the Storage gateway. |

## Environment Variables

| Variable                | Purpose                                         | Required?                                               |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for the `--linked` resolver path     | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the linked/remote connection       | no                                                      |
| `SUPABASE_YES`          | auto-confirm the reset prompt                   | no (also `--yes`)                                       |
| `SUPABASE_EXPERIMENTAL` | routes the experimental schema-files path to Go | no (also `--experimental`)                              |
| `SUPABASE_PROJECT_ID`   | overrides the local container id (`utils.DbId`) | no                                                      |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success                                                          |
| `1`  | mutually exclusive target flags (`[db-url linked local]`)        |
| `1`  | `--version` + `--last` together (`[last version]`)               |
| `1`  | `--version` not an integer (`invalid version number`)            |
| `1`  | `--version` has no matching migration file                       |
| `1`  | local: database not running (`supabase start is not running.`)   |
| `1`  | user declined the reset confirmation (`context canceled`)        |
| `1`  | `config.toml` parse failure                                      |
| `1`  | drop / migrate / seed / vault apply failure, or connection error |
| `1`  | local: container recreate / storage health-gate failure (seam)   |

## Output

The remote path prints `Resetting remote database…` to **stderr**, then the
drop/migrate/seed progress (`Applying migration …`, `Seeding data from …`). Go
connects with `io.Discard`, so there is **no** `Connecting to … database…` line and
**no** `Finished …` line on the remote path.

The local path prints `Resetting local database…` to **stderr**, then the seam's
`Recreating database...` / `Restarting containers...` progress, and finally
`Finished supabase db reset on branch <branch>.` (`supabase db reset` and `<branch>`
in Aqua).

### `--output-format text` (Go CLI compatible)

Byte-matches Go's stderr progress for both the remote and local paths. The
`--experimental` remote path passes the delegated Go binary's output through
unchanged.

### `--output-format json` / `stream-json`

stdout is payload-only; a `result` object is emitted:

```json
{ "target": "remote" | "local", "version": "<resolved version or empty>" }
```

In machine modes the remote confirmation prompt is non-interactive and takes its
default (`false`), so a remote reset is declined unless `--yes` is set. The local
path has no confirmation prompt.

## Notes

- **Target/local split** follows Go's `IsLocalDatabase(resolved config)`, not the
  flag name: a `--db-url` pointing at the local stack is treated as a local reset.
- `--no-seed` forces seeding off (Go sets `Config.Db.Seed.Enabled = false`); on the
  local path it is forwarded to the recreate seam so `MigrateAndSeed` skips the seed.
- `--sql-paths` overrides `[db.seed].sql_paths` for one reset and force-enables seeding
  even when `[db.seed].enabled = false`; repeat it to seed multiple files or glob
  patterns (supabase-relative). Mutually exclusive with `--no-seed`. On the local path
  it is forwarded to the recreate seam; on the remote path it seeds the selected
  database after migrations (Go warns when paired with `--linked` / `--db-url`).
- `--last n` reverts the most recent `n` migrations; if `n ≥ total`, the reset target
  version becomes `-` (revert everything). Mutually exclusive with `--version`.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- **Known interim**: only `--experimental` remote resets run via the Go binary; the
  best-effort pg-delta catalog cache (inside the seam) is not surfaced (no output
  impact). `encrypted:` vault secrets are skipped on the remote path.

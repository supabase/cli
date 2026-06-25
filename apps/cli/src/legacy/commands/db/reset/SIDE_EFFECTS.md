# `supabase db reset`

Native TypeScript port of `apps/cli-go/internal/db/reset/reset.go`. Reinitialises a
database from local migrations (plus seed). The **remote** path (`--linked`, or a
remote `--db-url`) is native: drop all user schemas, upsert vault secrets, then
re-apply migrations and seed. The **local** path (`--local`/default, or a `--db-url`
pointing at the local stack) and the niche `--experimental` schema-files path
delegate to the bundled Go binary — an interim until the container-bootstrap seam
is ported (CLI-1325 Stage 3).

## Files Read

| Path                                  | Format     | When                                                                     |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| `<workdir>/supabase/migrations/`      | directory  | to validate `--version` / resolve `--last`, and to load migrations       |
| `<workdir>/supabase/config.toml`      | TOML       | remote path (embedded defaults when absent)                              |
| `~/.supabase/<hash>/project-ref`      | plain text | `--linked`, to resolve the ref                                           |
| `~/.supabase/access-token`            | plain text | `--linked`, when `SUPABASE_ACCESS_TOKEN` unset and a temp role is minted |
| seed files from `[db.seed].sql_paths` | SQL        | remote path, when `[db.seed].enabled` and not `--no-seed`                |

## Files Written

| Path                                             | Format | When                              |
| ------------------------------------------------ | ------ | --------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | `--linked` (post-run cache)       |
| `~/.supabase/telemetry.json`                     | JSON   | always (post-run telemetry flush) |

The local / experimental paths additionally produce whatever the delegated Go
binary writes (container volumes, `_current_branch`, etc.).

## Database Mutations (remote path)

| Statement                                                                                       | When                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `drop.sql` `DO` block (drops user schemas/extensions/public objects, truncates auth/migrations) | always, first                                                |
| `SELECT vault.update_secret(...)` / `vault.create_secret(...)`                                  | when `[db.vault]` has syncable secrets                       |
| migration statements + `schema_migrations` history insert (per file, transactional)             | when `[db.migrations].enabled`, for migrations `≤ --version` |
| seed statements + `seed_files` hash upsert                                                      | when `[db.seed].enabled` and not `--no-seed`                 |

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                                                                       |
| ------ | ---- | ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| —      | —    | —    | —            | Connects to Postgres directly. The `--linked` db-config resolver may call the Management API to mint a temporary login role. |

## Environment Variables

| Variable                | Purpose                                         | Required?                                               |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for the `--linked` resolver path     | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`  | password for the linked/remote connection       | no                                                      |
| `SUPABASE_YES`          | auto-confirm the reset prompt                   | no (also `--yes`)                                       |
| `SUPABASE_EXPERIMENTAL` | routes the experimental schema-files path to Go | no (also `--experimental`)                              |

## Exit Codes

| Code | Condition                                                        |
| ---- | ---------------------------------------------------------------- |
| `0`  | success                                                          |
| `1`  | mutually exclusive target flags (`[db-url linked local]`)        |
| `1`  | `--version` + `--last` together (`[last version]`)               |
| `1`  | `--version` not an integer (`invalid version number`)            |
| `1`  | `--version` has no matching migration file                       |
| `1`  | user declined the reset confirmation (`context canceled`)        |
| `1`  | `config.toml` parse failure                                      |
| `1`  | drop / migrate / seed / vault apply failure, or connection error |

## Output

The remote path prints `Resetting remote database…` to **stderr**, then the
drop/migrate/seed progress (`Applying migration …`, `Seeding data from …`). Unlike
`db push`, Go connects with `io.Discard`, so there is **no** `Connecting to …
database…` line and **no** `Finished …` line.

### `--output-format text` (Go CLI compatible)

Byte-matches Go's stderr progress for the remote path. The local / experimental
paths pass the delegated Go binary's output through unchanged.

### `--output-format json` / `stream-json`

stdout is payload-only; on a confirmed remote reset a `result` object is emitted:

```json
{ "target": "remote", "version": "<resolved version or empty>" }
```

In machine modes the confirmation prompt is non-interactive and takes its default
(`false`), so a remote reset is declined unless `--yes` is set.

## Notes

- **Target/local split** follows Go's `IsLocalDatabase(resolved config)`, not the
  flag name: a `--db-url` pointing at the local stack is treated as a local reset
  and delegated.
- `--no-seed` forces seeding off (Go sets `Config.Db.Seed.Enabled = false`).
- `--last n` reverts the most recent `n` migrations; if `n ≥ total`, the reset
  target version becomes `-` (revert everything).
- **Known interim**: local `db reset` and `--experimental` remote resets run via the
  Go binary; the best-effort pg-delta catalog cache is not ported (no output impact).

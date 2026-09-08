# supabase-pull

Refreshes local project state from a linked Supabase project or branch in one step, instead of running `config pull`, `db pull`, `migration fetch`, and `functions download` individually. It runs four steps, always in this order: pull config into `supabase/config.toml`, optionally fetch the remote migration history table into `supabase/migrations`, pull the database schema into `supabase/migrations` (also updating that database's own migration history table), and download every Edge Function's source into `supabase/functions`. The order is fixed rather than parallel: the database step depends on `db.major_version` in the config file the first step may have just changed, and on the local migration history the second step may have just populated.

Pass `--project-ref` to target a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target.

On a fresh checkout with no `supabase/migrations` directory (or an empty one), the migration history step runs automatically even without `--with-migration-history` — there's nothing local to overwrite, and it's what lets the database step run at all: without it, `db pull` would hard-fail comparing an empty local directory against a remote project that already has migration history. Pass `--with-migration-history` to force a re-fetch even when the directory already has files.

`supabase pull` shows one confirmation before writing anything, covering all four steps. The config step's part of that confirmation is a real diff, computed the same way `config diff`/`config pull` compute theirs; the database, migration history, and functions steps have no diff of their own to show, so each gets one line describing what it will do. `--dry-run` previews this without writing or changing anything. `--yes` skips the confirmation and takes its default answer. `--force` writes even when `supabase/config.toml` has uncommitted or untracked changes in git — without it, an interactive run's confirmation defaults to declining instead of proceeding, and every other case (non-interactive, machine output format, or `--yes` on any TTY) aborts outright rather than silently overwriting local edits.

**This command is not purely a local, read-only refresh.** Pulling the database schema also updates that database's own migration history table on the **remote** project — the same behavior `db pull` has always had — not just a local file write. The database step also requires Docker (it runs a shadow Postgres container, and — on the very first pull — a `pg_dump` container) to compute the schema diff. Without Docker running, that one step fails and is reported as such, but the other three steps (config, migration history, functions) still run and complete normally; a project with nothing in its database yet can still successfully pull its config and functions without Docker installed.

If the database is already in sync with the local migrations, that step reports `unchanged` rather than failing — this differs from running `supabase db pull` directly, which treats "nothing to pull" as an error condition.

Storage bucket definitions are not pulled by this command: the Management API doesn't currently return enough detail (file size limits, allowed MIME types, the storage backend path) to populate `storage.buckets` config faithfully.

## Example

```sh
supabase pull
```

Pulls config, database schema, and functions from the linked project, fetching migration history first if `supabase/migrations` is empty.

```sh
supabase pull --project-ref staging
```

Pulls from the `staging` branch of the linked project.

```sh
supabase pull --dry-run
```

Shows what would be pulled — a real config diff, plus a description of what the other three steps would do — without writing anything.

Machine-readable output is available through `--output-format json|stream-json` — a single object (`schema_version`, `target`, `dry_run`, `confirmed`, `wrote`, `step_order`, `steps`, `counts`) with one entry per step under `steps`, keyed `config`, `migration_history`, `db`, and `functions`, each carrying its own `status` (`changed`, `unchanged`, `skipped`, `planned`, or `failed`), the paths it wrote, and a step-specific `detail` object. The legacy global `-o`/`--output` flag is not supported by this command; use `--output-format json|stream-json` instead.

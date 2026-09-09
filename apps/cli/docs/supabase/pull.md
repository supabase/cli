# supabase-pull

Refreshes local project state from a linked Supabase project or branch in one step, instead of running `config pull`, `db pull`, `migration fetch`, and `functions download` individually. It runs four steps, always in this order: pull config into `supabase/config.toml`, optionally fetch the remote migration history table into `supabase/migrations`, pull the database schema into `supabase/migrations` (also updating that database's own migration history table), and download every Edge Function's source into `supabase/functions`. The order is fixed rather than parallel: the database step depends on `db.major_version` in the config file the first step may have just changed, and on the local migration history the second step may have just populated.

Pass `--project-ref` to target a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target. `--remote-label` overrides the `[remotes.*]` block the config step would otherwise reuse or create for that target, identically to `config pull`'s own flag of the same name (see `supabase config pull`'s docs for the reuse/creation rules it follows).

On a fresh checkout, the migration history step runs automatically even without `--with-migration-history`, whenever `supabase/migrations` is missing or a raw directory listing of it turns up no entries at all — the same "existing files" check `migration fetch` itself uses, so a directory holding only a `.gitkeep`/`README.md` already counts as non-empty for this purpose (the listing is unfiltered — any entry at all disqualifies it) and the two commands never disagree about it. There's nothing local to overwrite when the directory is truly empty or missing, and it's what lets the database step run at all: without it, `db pull` would hard-fail comparing an empty local directory against a remote project that already has migration history. Pass `--with-migration-history` to force a re-fetch whenever the directory already has any files in it, including only non-migration ones — unlike the bootstrap case, this DOES overwrite: any local migration file that shares a name with a remote history entry is replaced.

`supabase pull` shows one confirmation before writing anything, covering all four steps. It opens by naming the target (`Pulling from project <ref>`, or with `(branch "<name>")` appended when the target is a branch), then lists the four steps in the order they run: the config step's part is a real diff, computed the same way `config diff`/`config pull` compute theirs (or "No config differences found." when there is nothing to change); the migration-history line only appears when that step will actually run this invocation, and calls out that it overwrites same-named local files when it's running because of `--with-migration-history` rather than the bootstrap case; the database line notes that it also updates the remote migration history table and requires Docker; the functions line describes the download. `--dry-run` prints this exact same disclosure body — not a placeholder or a status-only summary — before exiting without writing or changing anything. `--yes` skips the confirmation and takes its default answer.

`supabase pull` checks THREE locations for uncommitted or untracked changes in git before writing: `supabase/config.toml` (or `config.json`), `supabase/migrations`, and `supabase/functions`. The config check only fires when the config step itself has work to write — a config that's already fully converged with the target never triggers it. The other two fire unconditionally: the database step always attempts to run and has no way to know in advance whether it will find schema drift and write into `supabase/migrations`, and the functions step always runs with no equivalent "nothing to do" signal available without calling the API first — so both are checked every run to avoid silently missing real uncommitted work. Each location's dirty state is tracked separately: the confirmation body and any abort message name exactly which path(s) are actually dirty, e.g. `supabase/config.toml has uncommitted or untracked changes...` for one, or `supabase/config.toml, supabase/migrations, and supabase/functions have uncommitted or untracked changes...` when all three are. `--force` writes even when any of the three is dirty — without it, an interactive run's confirmation defaults to declining instead of proceeding, and every other case (non-interactive, machine output format, or `--yes` on any TTY) aborts outright rather than silently overwriting local edits.

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

Prints the full confirmation body — the target header, the real config diff (or "No config differences found."), the migration-history/database/functions lines (including the Docker mention and, if applicable, the uncommitted-changes warning) — without writing or changing anything.

```sh
supabase pull --remote-label staging
```

Pulls into the `[remotes.staging]` block instead of whatever block the target would otherwise reuse or create.

Machine-readable output is available through `--output-format json|stream-json` — a single object (`schema_version`, `target`, `dry_run`, `confirmed`, `wrote`, `step_order`, `steps`, `counts`) with one entry per step under `steps`, keyed `config`, `migration_history`, `db`, and `functions`, each carrying its own `status` (`changed`, `unchanged`, `skipped`, `planned`, or `failed`), the paths it wrote, and a step-specific `detail` object. The legacy global `-o`/`--output` flag is not supported by this command; use `--output-format json|stream-json` instead.

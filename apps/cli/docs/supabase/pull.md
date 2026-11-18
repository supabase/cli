# supabase-pull

Refreshes your local project from a linked Supabase project or branch in one step, instead of running `config pull`, `db pull`, `migration fetch`, and `functions download` separately. Use it to sync a checkout with what is deployed.

It runs four steps in a fixed order: pull the config into `supabase/config.toml`, optionally fetch the remote migration history into `supabase/migrations`, pull the database schema into `supabase/migrations`, and download every Edge Function's source into `supabase/functions`. The order matters because the database step depends on `db.major_version` in the config and on the local migration history.

**This command is not purely a local refresh.** Pulling the database schema also updates that database's migration history table on the **remote** project, as `db pull` does.

## Target

Pass `--remote=<ref|branch>` to pull from a specific project, or from the name or UUID of a branch of the linked project. Values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target. `--project-ref` still works in v3 but is deprecated and removed in v4.

`--remote-label` overrides the `[remotes.*]` block the config step would otherwise reuse or create for that target, as in `config pull`.

## Migration history

On a fresh checkout, the migration history step runs automatically whenever `supabase/migrations` is missing or has no entries at all. A directory holding only a `.gitkeep` or `README.md` counts as non-empty. This is the same check `migration fetch` uses, and it lets the database step run without failing on an empty local directory.

Pass `--with-migration-history` to fetch again when the directory already has files. This overwrites any local migration file that shares a name with a remote history entry.

## Confirmation

The command prints the resolved target once (`Target: ...` on stderr), then asks for one confirmation before writing anything. The prompt lists the four steps, including a real config diff (or "No config differences found.") and a note that the database step requires Docker. `--dry-run` prints this same disclosure and exits without writing or changing anything.

Because the database step records the migration in the remote history table, the prompt defaults to **No**. Declining exits non-zero with `context canceled`. `--yes`, or `SUPABASE_YES` set in the shell environment, confirms it; a `SUPABASE_YES` in `supabase/.env` does not. `--output-format json|stream-json` and non-interactive runs cannot prompt, so they need `--yes`; an answer piped to stdin is ignored.

`--yes` also lets the database connection remove a network ban that blocks the temporary login role. Without it, the step fails and suggests re-running with `--yes` or running `supabase network-bans remove --remote=<ref>`.

## Uncommitted changes

Before writing, the command checks git for uncommitted or untracked changes in `supabase/config.toml` (or `config.json`), `supabase/migrations`, and `supabase/functions`. The config check only applies when the config step has something to write; the other two apply on every run. The confirmation and any abort message name exactly which paths are dirty.

`--force` writes even when a path is dirty. Without it, an interactive run shows a warning in the prompt, and every other run (non-interactive, machine output, or `--yes`) aborts rather than overwrite local edits.

## Docker and limits

The database step needs Docker, because it runs a shadow Postgres container and, on the first pull, a `pg_dump` container. Without Docker that step fails and is reported, but the config, migration history, and functions steps still complete.

If the database already matches the local migrations, the step reports `unchanged`. Running `supabase db pull` directly treats that case as an error.

Storage bucket definitions are not pulled, because the Management API doesn't return enough detail to populate `storage.buckets` faithfully.

## Example

```sh
supabase pull
```

Pulls config, database schema, and functions from the linked project, fetching migration history first if `supabase/migrations` is empty.

```sh
supabase pull --remote=staging
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

Machine-readable output is available through `--output-format json|stream-json` — a single object (`schema_version`, `target`, `dry_run`, `confirmed`, `wrote`, `step_order`, `steps`, `counts`) with one entry per step under `steps`, keyed `config`, `migration_history`, `db`, and `functions`, each carrying its own `status` (`changed`, `unchanged`, `skipped`, `planned`, or `failed`), the paths it wrote, and a step-specific `detail` object. `target` carries `kind: "linked"`, `project_ref`, `environment` (`production`, `branch`, or `unverified`), `project_name` and `parent_project_ref` when known, and `branch` when `--remote` named one. The legacy global `-o`/`--output` flag is not supported by this command; use `--output-format json|stream-json` instead.

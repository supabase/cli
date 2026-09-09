# `supabase pull`

Orchestrates four existing pull-style commands — `config pull`, an optional `migration fetch`,
`db pull`, and `functions download` — behind one target resolution, one confirmation, and one
aggregated result (ADR 0024). Each reused step is invoked through its own **run-core** (a typed
outcome, no `output.success` call of its own), so only `pull` itself resolves the target, prompts,
and emits — the sub-steps never fire their own prompt, confirmation, or telemetry event when run
this way. This file documents only what `pull` itself owns; for a sub-step's own file-by-file/API
detail, see its own `SIDE_EFFECTS.md`:

- [`config pull`](../config/pull/SIDE_EFFECTS.md)
- [`db pull`](../db/pull/SIDE_EFFECTS.md)
- [`migration fetch`](../migration/fetch/SIDE_EFFECTS.md)
- [`functions download`](../functions/download/SIDE_EFFECTS.md)

**This command is not purely a local-file refresh.** The `db` step writes
`supabase_migrations.schema_migrations` on the **remote** database (not just local files) whenever
it actually pulls a migration-mode schema change, and that step requires Docker (shadow database +
initial-pull `pg_dump` container). See "Database writes" and "Docker" below.

## Files Read

| Path                                                       | Format     | When                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json`          | TOML/JSON  | always, before any network call — `openConfigPullSource`, the SAME base load `config pull` itself opens (no `[remotes.*]` overlay yet); see `config/pull/SIDE_EFFECTS.md` for the loader's own rules                                         |
| `<workdir>/supabase/.env`, `.env.local`                    | dotenv     | always, to resolve `env(VAR)` references inside `config.toml` (via the config step's loader)                                                                                                                                                 |
| `<workdir>/supabase/.temp/project-ref`                     | plain text | project-ref fallback (flag → `SUPABASE_PROJECT_ID` → this file) when `--project-ref` is absent; parent-ref candidate for a branch-name `--project-ref` (checked eagerly, before any spinner or branch lookup)                                |
| `<workdir>/supabase/.temp/linked-project.json`             | JSON       | parent-ref candidate for a branch-name `--project-ref` (same eager pre-check)                                                                                                                                                                |
| `~/.supabase/access-token`                                 | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                                                   |
| `<workdir>/supabase/config.toml` or `config.json` (reload) | TOML/JSON  | re-loaded WITH the `[remotes.*]` overlay applied, only when the resolved target ref matches an existing `[remotes.*]` block — the config step's own conditional reload (`config/pull/SIDE_EFFECTS.md`)                                       |
| `<workdir>/supabase/migrations` (directory listing)        | filenames  | once, in the preview phase, to decide whether the migration-history step auto-runs — skipped when `--with-migration-history` is already set (see Notes); a read failure other than "directory missing" fails the whole command at this point |
| same config file, raw on-disk text (TOCTOU re-read)        | TOML/JSON  | immediately before the config step writes, once the aggregated confirmation is accepted — only reached when the config plan has work; see `config/pull/SIDE_EFFECTS.md`'s TOCTOU row                                                         |

Each executed sub-step also performs its own file reads exactly as documented in its own
`SIDE_EFFECTS.md` (config, db, functions, and — when it runs — migration history), since `pull`
threads the already-resolved `ref` into each step's existing `--project-ref`-shaped input rather
than having each step re-resolve it (ADR 0024's "resolve once" decision) — most of a sub-step's own
target-resolution file reads are therefore skipped in practice (the ref is already ref-shaped, so
`ProjectRefResolver.loadProjectRef` short-circuits with no file/network access).

## Files Written

| Path                                                   | Format    | When                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `config.json`      | TOML/JSON | config step only, once the aggregated confirmation is accepted AND the plan has work (never on `--dry-run`, never on a declined confirmation) — same atomic surgical-edit write as standalone `config pull` (`config/pull/SIDE_EFFECTS.md`) |
| `<workdir>/supabase/migrations/<version>_<name>.sql`   | SQL       | migration-history step only, when it actually runs (bootstrap or `--with-migration-history`) and the confirmation is accepted — see `migration/fetch/SIDE_EFFECTS.md`                                                                       |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql` | SQL       | db step, migration mode, when it finds schema drift — see `db/pull/SIDE_EFFECTS.md`                                                                                                                                                         |
| `<workdir>/supabase/functions/<slug>/...`              | bytes     | functions step, for each function the linked project has — see `functions/download/SIDE_EFFECTS.md`                                                                                                                                         |
| `<workdir>/supabase/.temp/linked-project.json`         | JSON      | `Effect.ensuring` after `pull`'s own run (success and failure), once a target ref has resolved                                                                                                                                              |
| `~/.supabase/telemetry.json`                           | JSON      | `Effect.ensuring` after `pull`'s own run (success and failure)                                                                                                                                                                              |

The two rows above are `pull`'s own top-level writes. Because the db and migration-history steps
are invoked as plain library functions (their run-cores), not as wrapped standalone commands, each
one's own internal `Effect.ensuring` also fires during the SAME `pull` invocation — so
`.temp/linked-project.json` and `telemetry.json` can each be written more than once per `pull` run
(once per step that has its own such write, plus `pull`'s own). This is additive, not a behavior
change to either file's contents (each write is idempotent for the same ref/state), and matches
each step's own documented "when" in its own `SIDE_EFFECTS.md`.

## Git

`pull` checks THREE locations for uncommitted or untracked git changes, independently, using the
same underlying mechanism `config pull` uses for its own config-only guard
(`pathHasUncommittedChanges`, `command-internal/git-status.ts`) but owned and called
directly by `pull` itself, not delegated to any sub-step's own guard (none of the reused run-cores
run a git check of their own):

| Path                                        | Spawns                                                                         | Checked when                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `.json` | `git status --porcelain -- config.toml` (cwd: the config file's own directory) | `--force` is absent AND the config step's own plan has work to write (`runPlan.hasWork` — CLI-2064 bug A: a converged config never spawns `git status` at all)                                                                                                                                                       |
| `<workdir>/supabase/migrations`             | `git status --porcelain -- migrations` (cwd: `<workdir>/supabase`)             | `--force` is absent. Unconditional otherwise — the db step always attempts to run and has no preview machinery of its own to know ahead of time whether it will find schema drift and write into this directory (ADR 0024), so this is checked regardless of whether the migration-history step itself will also run |
| `<workdir>/supabase/functions`              | `git status --porcelain -- functions` (cwd: `<workdir>/supabase`)              | `--force` is absent. Unconditional — the functions step always runs, with no "does it have work" signal available without calling the API first                                                                                                                                                                      |

Each location's dirty state is tracked separately, so the confirmation body and the abort error
each name exactly which path(s) are actually dirty (e.g. `supabase/config.toml has uncommitted or
untracked changes...` for one, `supabase/config.toml and supabase/functions have uncommitted or
untracked changes...` for two, `supabase/config.toml, supabase/migrations, and supabase/functions
have uncommitted or untracked changes...` for all three).

A dirty (or untracked) result on ANY of the three changes behavior by output mode, identically to
`config pull`'s own single-path guard: an interactive TTY text run without `--yes` downgrades the
aggregated confirmation prompt's default answer from yes to no and adds the warning (naming every
dirty path) to the confirmation body; every other case — a non-interactive or machine-format run,
or `--yes` passed on any TTY — aborts before the prompt (`PullUncommittedChangesError`, exit
1, naming every dirty path in its message). `--yes`/`SUPABASE_YES` never bypasses this guard; only
`--force` does, for all three locations at once.

A non-zero exit, a spawn failure, or the directory not being a git working tree all degrade
silently to "clean" for that one location (same degrade-on-uncertainty policy `config pull` uses) —
each location's check is independent, so a spawn failure on one does not affect another's result.

## API Routes

| #   | Purpose                 | Method | Path                                 | When                                                                                                                                        |
| --- | ----------------------- | ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | branch by UUID          | GET    | `/v1/branches/{branch_id}`           | `--project-ref` is a branch UUID — resolved once, up front (ADR 0024 "resolve once"); needs no linked project                               |
| 1b  | branch by name          | GET    | `/v1/projects/{ref}/branches/{name}` | `--project-ref` is a branch NAME (not a ref/UUID); the parent ref is resolved from local state first                                        |
| 2   | effective remote config | GET    | `/v2/projects/{ref}/config`          | the config step's own fetch (`planConfigPullRun`) — guaranteed single by the plan/apply split, never repeated for a dry run or a real apply |

Every other route belongs to a reused sub-step, called with the already-resolved `ref` (no
re-resolution): the db step's own routes (temp login role, IPv4 pooler config, linked-project
metadata — `db/pull/SIDE_EFFECTS.md`) and the functions step's own routes (function list,
per-function metadata/body, linked-project metadata — `functions/download/SIDE_EFFECTS.md`).
`migration fetch` calls no HTTP route of its own (it reads the remote database directly).

## Database writes

**The db step writes `supabase_migrations.schema_migrations` on the remote database, not just
local files, whenever it actually pulls a migration-mode schema change during this `pull`
invocation.** `pull` always suppresses `db pull`'s own "Update remote migration history table?"
prompt (`assumeYes: true` — the aggregated confirmation already covers this), so a migration-mode
pull that finds drift updates the remote history table unconditionally, not just locally. This
holds even though `pull`'s own top-level effect never asks about it a second time — see
`db/pull/SIDE_EFFECTS.md`'s own "API Routes / DB" table for the exact `UPSERT`. A declarative-mode
pull does not provision a shadow database and never touches this table.

## Docker

Required by the **db step only** — the shadow Postgres container (migration mode) and the initial
pull's native `pg_dump` container; see `db/pull/SIDE_EFFECTS.md` for the full lifecycle and the
shadow-baseline cache. Without Docker running, the db step fails and is reported as `status:
"failed"`, but this does **not** stop the other three steps: config, migration history, and
functions all still run and report normally, since each step is failure-isolated (see "Exit Codes"
below). The functions step defaults to the Docker-unbundle downloader too, but degrades gracefully
when Docker isn't running — it prints a warning and falls back to the native server-side download
path instead of failing (`functions/download/SIDE_EFFECTS.md`). A Docker-less run of `supabase
pull` therefore still completes config, migration history, and functions; only the db step is
Docker-dependent.

## Environment Variables

| Variable                | Purpose                                                                                                 | Required?                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_YES`          | answers `pull`'s own aggregated confirmation "yes" (same as `--yes`); does NOT bypass the dirty guard   | no — resolved via the GLOBAL flag (`resolveYes`), no project-`.env` fallback (unlike the sub-steps' own internal prompts, which are all bypassed by `pull` before they can read it) |
| `SUPABASE_PROJECT_ID`   | project ref (flag → this → `.temp/project-ref` → prompt)                                                | no                                                                                                                                                                                  |
| `SUPABASE_WORKDIR`      | working directory `config.toml`/`.json`/`supabase/migrations`/`supabase/functions` are resolved against | no                                                                                                                                                                                  |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                    | no (falls back to keyring → `~/.supabase/access-token`)                                                                                                                             |
| `SUPABASE_PROFILE`      | API profile selection                                                                                   | no                                                                                                                                                                                  |
| `env(VAR)` references   | interpolated into `config.toml` values by the config step's loader                                      | no                                                                                                                                                                                  |

Once the db and functions steps run, they consume their own established environment variables
exactly as documented in their own `SIDE_EFFECTS.md` files (e.g. `SUPABASE_DB_PASSWORD`,
`SUPABASE_DB_SHADOW_PORT`, `SUPABASE_SHADOW_CACHE`, `SUPABASE_NETWORK_ID`,
`SUPABASE_USE_SLIM_IMAGES`, `SUPABASE_EXPERIMENTAL_PG_DELTA` for db;
`SUPABASE_EDGE_RUNTIME_DENO_VERSION`, `SUPABASE_INTERNAL_IMAGE_REGISTRY`, `BITBUCKET_CLONE_DIR` for
functions) — `pull` does not read or override any of these itself, it only supplies the resolved
`ref`.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | every step succeeded (any mix of `changed`/`unchanged`/`skipped`)                                                                                                                                                                           |
| `0`  | `--dry-run` (every step reports `planned`/`skipped`, nothing written)                                                                                                                                                                       |
| `0`  | the aggregated confirmation was declined (every step reports `planned`/`skipped`, nothing written)                                                                                                                                          |
| `1`  | the `-o`/`--output` global flag passed (any value — not supported by this command, `PullOutputFlagUnsupportedError`)                                                                                                                        |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`PullWorkdirError`)                                                                                                                                             |
| `1`  | branch-name `--project-ref` target-resolution failure (`PullBranchNotLinkedError` / `PullParentRefInvalidError` / `PullBranchNotFoundError` / `PullBranchNotReadyError` / `PullBranchResolveNetworkError` / `PullBranchResolveStatusError`) |
| `1`  | `supabase/config.toml`/`.json`, `supabase/migrations`, and/or `supabase/functions` has uncommitted or untracked changes and no human will read the warning (`PullUncommittedChangesError`) — see Git above                                  |
| `1`  | any one step fails (config, migration history, db, or functions) — every OTHER step still runs and is reported, but the process exits non-zero and re-fails with the FIRST original failure's own cause/classification                      |

**Deliberate divergence from standalone `db pull`:** when the db step finds the remote already in
sync with local migrations (`DbPullInSyncError`), `pull` reports it as `status: "unchanged"`
— a finding, not a failure — rather than the non-zero exit standalone `db pull` gives that same
condition. Every other step's failure still counts as a `pull` failure.

## Telemetry Events Fired

| Event                  | When                                                      | Notable properties / groups                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via `withCommandTelemetry`) | `exit_code`, `duration_ms`, `flags`; `--project-ref`'s value is only in `safeFlags` (logged verbatim) when it is ref-shaped (`PROJECT_REF_PATTERN`) — a user-created branch name is redacted |

Exactly one `cli_command_executed` fires per `pull` invocation. None of the four reused steps fire
their own `cli_command_executed` (or any other event) when run through `pull` — each is called as a
plain library function (its run-core), never through its own `withCommandTelemetry`
wrapper, which lives only in that step's own standalone command handler.

## Output

### `--output-format text`

An aligned per-step summary block, one row per step in `config`, `migration_history`, `db`,
`functions` order:

```
Pull summary — project <ref>
  config              changed    supabase/config.toml
  migration_history   skipped    (not_needed)
  db                  changed    supabase/migrations/<timestamp>_remote_schema.sql
  functions           unchanged
```

A `failed` step's row inlines its own failure message (control characters stripped, so a
remote-controlled message — a function slug, an API response body — cannot forge fake additional
summary rows), even though only the FIRST original failure re-fails the process — so a
later-listed step can still show `failed` with its own message even when an earlier step is the
one whose cause actually exits the command non-zero.

Before this summary, the confirmation body is always printed — on `--dry-run` too, not just a real
run — starting with a header line naming the target (`Pulling from project <ref>`, or `Pulling
from project <ref> (branch "<branch>")` when a branch is set), then one section per step in
`PULL_STEP_ORDER` order (config's own real diff, or "No config differences found."; a
migration-history line, only when that step will actually run this invocation, calling out that it
overwrites same-named local files when the reason is `--with-migration-history` rather than the
bootstrap case; a db line noting it also updates the remote migration history table and requires
Docker; a functions line). The aggregated "Proceed with pull?" prompt follows, unless `--yes` is
set or the run is `--dry-run`/declined.

### `--output-format json` / `stream-json`

`output.success(message, payload)` on success/dry-run/declined; on a partial failure, the payload
is instead attached to the single JSON/stream-json error envelope via `MachineErrorContext` (spread
onto the envelope's top level, alongside `_tag`/`error`) before the process fails — never a second,
separate JSON object. `schema_version` is `pull`'s own payload version
(`PULL_PAYLOAD_VERSION`, currently `1`), independent of any sub-step's own payload version.
Shape (`pull.format.ts`):

```jsonc
{
  "schema_version": 1,
  "target": { "project_ref": "...", "branch": "..." }, // branch omitted if absent
  "dry_run": false,
  "confirmed": true,
  "dirty_paths": [], // always present, even on a clean tree — populated when the git-dirty guard found uncommitted/untracked paths
  "wrote": true, // true whenever ANY step's status is "changed", OR any step (including a failed one) has a non-empty "written" array
  "step_order": ["config", "migration_history", "db", "functions"],
  "steps": {
    "config": {
      "status": "changed",
      "written": ["supabase/config.toml"],
      "detail": {/* config pull's own payload, verbatim */},
    },
    "migration_history": {
      "status": "skipped",
      "written": [],
      "detail": { "files": [] },
      "reason": "not_needed",
    },
    "db": {
      "status": "changed",
      "written": ["supabase/migrations/..."],
      "detail": { "declarative": false, "engine": "pg-delta", "remote_history_updated": true },
    },
    "functions": {
      "status": "unchanged",
      "written": [],
      "detail": { "project_ref": "...", "function_slugs": [] },
    },
  },
  "counts": { "changed": 2, "unchanged": 1, "skipped": 1, "planned": 0, "failed": 0 },
}
```

A `failed` step's own entry additionally carries `failure: { message, suggestion?, code? }` — `code`
is the squashed cause's own `_tag`, when it has one, so a machine consumer can classify a non-first
(never re-failed) step's failure without parsing `message`. `steps.config
.detail` is the config step's own machine payload verbatim (`config/pull/SIDE_EFFECTS.md` describes
every field of it); the other three steps' `detail` shapes are `pull`-owned and narrower, as shown
above.

### `-o`/`--output` (machine formats)

Not supported. `pull` is a net-new TS command with no Go parity contract (CLI-2156). Any
`-o`/`--output` value — every machine-format value AND `pretty` — is rejected outright before any
config load, target resolution, or network call:

```
the -o/--output flag is not supported by pull; use --output-format json|stream-json instead.
```

## Notes

- **Steps run sequentially, not in parallel**, refining ADR 0004's "runs all sub-syncs in parallel"
  aspiration for `pull` specifically — see [ADR
  0024](../../../../../docs/adr/0024-top-level-pull-orchestration.md) for the two real data
  dependencies (config → db via `db.major_version`; migration history → db via the local
  `supabase/migrations` directory db pull reconciles against) and the shared-terminal-progress
  constraint that also rules out concurrency.
- **Migration history auto-runs on a fresh checkout**, even without `--with-migration-history`:
  whenever `supabase/migrations` is missing, or a raw (unfiltered) directory listing of it is
  empty, the step runs anyway, since there is nothing local to overwrite and a bootstrap checkout
  would otherwise hit `db pull`'s own hard failure when the remote has history the local directory
  doesn't (`DbPullMigrationConflictError`). This eligibility check is DELIBERATELY the same
  raw-listing predicate `migration fetch`'s own overwrite-confirmation guard uses for "existing
  files" (not the filtered, `MIGRATE_FILE_PATTERN`-matching count `loadLocalVersions`
  produces for db/migration reconciliation elsewhere) — so a directory holding only a
  `README.md`/`.gitkeep`/deprecated `_init.sql` reads as non-empty to both checks, never
  auto-running the bootstrap case over files `migration fetch`'s own standalone guard would have
  asked to confirm overwriting. `--with-migration-history` remains for forcing a re-fetch over an
  already-populated directory — that case IS a real overwrite of same-named local files, and the
  confirmation body says so.
- **`--remote-label`** redirects the config step's write from the config root into a
  `[remotes.<label>]` block, identically to `config pull`'s own flag of the same name (see
  `config/pull/SIDE_EFFECTS.md`) — `pull` threads the flag's value straight through to
  `planConfigPullRun`'s `remoteLabel` parameter.
- **A `db`-step failure classified as `DbPullMigrationConflictError`** (the remote migration
  history doesn't match local files) gets one extra line appended to its `suggestion`, pointing at
  `supabase pull --with-migration-history` as the more direct fix `pull` itself provides — on top
  of that error's own built-in `supabase migration repair` commands. This is `pull`-only framing;
  the underlying error class (shared with standalone `db pull`) is unchanged.
- **Storage buckets are deliberately absent from this command in v1.** The Management API's bucket
  list endpoint (`v1ListAllBuckets`) does not return `file_size_limit`/`allowed_mime_types`/
  `objects_path`, so there is no faithful way to populate `storage.buckets` config from it
  (BRA-268, unstarted upstream). Adding a storage step later is additive — see ADR 0024's
  non-goals.
- **The config step never runs its own dirty guard or its own no-work short-circuit prompt-skip.**
  `pull` calls `planConfigPullRun`/`applyConfigPullRun` directly (the plan/apply split),
  never `runConfigPull` — so standalone `config pull`'s own git check and its "nothing to do,
  skip the prompt entirely" behavior are both bypassed in favor of `pull`'s own single guard and
  single aggregated prompt (which always runs, even when the config step itself has no work, since
  the other three steps might).
- `pull`'s own `--yes`/`SUPABASE_YES` resolution has no project-`.env` fallback (unlike `db
pull`/`migration fetch`'s own internal resolution) — this doesn't matter in practice, since every
  reused step's own prompt is unconditionally bypassed (`assumeYes: true`) once `pull`'s own
  confirmation is accepted.
- **The db step always runs in migration mode when orchestrated by `pull`, never the declarative
  path.** `pull` never sets `--declarative`/`--use-pg-delta`/`--diff-engine` on its own db-step
  invocation, AND `pullDbStep` (`pull.steps.ts`) passes `forceMigrationMode: true` into `runDbPull`
  (`command-internal/db-pull-run.ts`), which forces `experimental` to `false` unconditionally,
  regardless of any ambient `--experimental` flag or `SUPABASE_EXPERIMENTAL` (shell or project
  dotenv). The deprecated `--experimental`-without-`--declarative` structured-dump export therefore
  can never engage when the db step runs through `pull` — see `db/pull/SIDE_EFFECTS.md`'s own notes
  on that path, which still applies to the standalone `db pull` command.

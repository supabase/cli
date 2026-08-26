# pg-delta declarative schema — human dogfooding scenarios

pg-delta and the declarative schema workflow are becoming the only `db diff` / `db pull` /
declarative experience. This document is a set of complete, human-runnable scenarios to dogfood
that experience end to end against **staging**, using only the CLI commands a real user would
run. Each scenario states its starting point, the exact commands, the expected outcome, and what
to pay attention to as a dogfooder.

Run the scenarios in order the first time — later ones assume you are comfortable with the
earlier flows. Every scenario is safe to run on a disposable staging project.

## Prerequisites

- Docker Desktop (or a running Docker daemon) — shadow databases and the local stack need it.
- A **staging** Supabase account and access token.
- A disposable staging project (create one in the staging dashboard, or reuse a scratch project).
  Several scenarios mutate the remote schema; never point these at a project you care about.
- The CLI built from this repo (`bun src/supabase.ts …` from `apps/cli/`, or a released binary).

### Environment setup

All commands below assume:

```sh
export SUPABASE_ACCESS_TOKEN=sbp_...          # staging token
export SUPABASE_PROFILE=supabase-staging      # api.supabase.green / db.<ref>.supabase.red
export SUPABASE_DB_PASSWORD=...               # the staging project's database password
```

`supabase-staging` is a built-in profile: Management API at `https://api.supabase.green`,
project data plane at `<ref>.supabase.red`. Tokens are stored per profile, so your production
login is untouched. `--profile supabase-staging` per command works too.

When a scenario says "connect directly with `--db-url`", prefer the direct connection
(`postgresql://postgres:<password>@db.<ref>.supabase.red:5432/postgres`) over the pooler so
pg-delta can introspect the full catalog reliably.

### The pg-delta gate

Declarative commands require `--experimental` **or** the config gate:

```toml
[experimental.pgdelta]
enabled = true
```

A fresh `supabase init` writes `enabled = true` by default, so new projects are already opted
in — this is itself something to dogfood (Scenario 2). Pre-existing projects without the section
stay on migra until you add it. Optional keys under the same section:
`declarative_schema_path = "./schemas"` (directory under `supabase/`) and `format_options`
(JSON string for SQL formatting; `"null"` emits raw statements).

### What to record in every scenario

- Any prompt, warning, or error that confused you, fired at the wrong time, or was missing.
- Generated SQL that is wrong, non-idempotent, oddly formatted, or noisy (spurious diffs).
- Any "coverage" warning from pg-delta (objects it cannot manage) — note the object type.
- Wall-clock time of shadow-database steps (first run vs. warm run).
- When a diff/pull comes back unexpectedly empty: rerun with `PGDELTA_DEBUG=1` and attach the
  debug bundle from `supabase/.temp/pgdelta/` (kept out of git; unlike `--debug`, this keeps
  SSL enabled against staging).

---

## Scenario matrix

| #   | Scenario                          | Starting point                                | Core commands                                                                                       |
| --- | --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Adopt on an existing project      | Remote project **with** migrations/schema     | `link`, `db pull`, `migration list`, `db schema declarative generate`, `db schema declarative sync` |
| 2   | Greenfield, declarative-first     | Remote project **without** migrations         | `init`, `start`, `generate`, `sync`, `db push`                                                      |
| 3   | Day-to-day iteration loop         | Scenario 1 or 2 completed                     | edit schemas, `sync`, `db push`                                                                     |
| 4   | Remote drift resolution           | Someone changed staging via the dashboard     | `db diff --linked`, `db pull`, `generate --overwrite`, `sync`                                       |
| 5   | Local drift resolution            | You hacked on the local DB directly           | `generate --local`, `sync --no-apply`, `db reset`                                                   |
| 6   | Migration history repair          | Local/remote history out of sync              | `migration list`, `migration repair`, `db pull`                                                     |
| 7   | Fresh clone / teammate onboarding | Repo with schemas + migrations, clean machine | `start`, `db reset`, `sync`, `migration list`                                                       |
| 8   | Squash a long history             | Many migrations accumulated                   | `migration squash`, `sync`, `migration repair`                                                      |
| 9   | Review-only diffs                 | Any linked project                            | `db diff --from … --to …`                                                                           |
| 10  | Legacy declarative tree upgrade   | Old (manifest-less) pg-delta export           | `sync` (gate), `generate --output-dir`                                                              |
| 11  | Escape hatches & debugging        | Anything above went wrong                     | `--diff-engine migra`, `--use-migra`, `--strict-coverage`, `--no-cache`, `PGDELTA_DEBUG`            |

---

## Scenario 1 — I have a remote project with migrations: pull them and go declarative

**Starting point:** a staging project whose schema was built with classic migrations (if you
don't have one, run Scenario 2 on a scratch project first, then delete your local checkout and
start here). Local directory is empty.

```sh
supabase init                        # writes config.toml with [experimental.pgdelta] enabled = true
supabase link --project-ref <ref>    # validates config against the platform, stores password
supabase db pull                     # migration-mode pull; pg-delta runs the shadow diff
# → confirm the "Update remote migration history table?" prompt with Y
supabase migration list              # local and remote columns should match
```

Notes on `db pull` under pg-delta:

- On a project whose history table is empty, pg-delta replaces `pg_dump` for the initial pull:
  the whole schema arrives as the shadow diff. Expect `supabase/migrations/<ts>_remote_schema.sql`.
- Plans that cross a transaction boundary (e.g. `ALTER TYPE … ADD VALUE` plus a use of the new
  value) legitimately produce **multiple ordered files** (`<ts>_remote_schema_….sql`,
  `<ts+1s>_….sql`), each recorded in history. Verify the ordering makes sense.

Now bootstrap the declarative tree from the same remote:

```sh
supabase db schema declarative generate --linked
```

Expected layout under `supabase/schemas/`: one directory per schema
(`public/tables/<table>.sql`, `public/schema.sql`, …), cluster-level objects under `_cluster/`
(e.g. `_cluster/roles.sql`), and an export manifest `.pgdelta-export.json`. The export never
writes to or prunes `_custom/` — that directory is yours for hand-authored SQL pg-delta does
not model.

**Convergence check (the point of the scenario):** the migrations state and the declarative
tree now describe the same database, so:

```sh
supabase db schema declarative sync
```

must print `No schema changes found`. Anything else is a coverage/rendering bug in pg-delta —
capture the generated SQL and file it.

Finally, verify the local stack replays cleanly:

```sh
supabase start
supabase db reset      # applies all pulled migrations to the local DB
supabase db schema declarative sync    # still: No schema changes found
```

**Dogfood focus:** initial-pull SQL quality (compare a few objects against the dashboard),
whether the generate/sync pairing converges to zero, and whether the two-command bootstrap
(`db pull` then `generate`) feels discoverable or needs better signposting.

---

## Scenario 2 — Greenfield: no migrations anywhere, declarative-first from day one

**Starting point:** a brand-new (empty) staging project, empty local directory.

```sh
supabase init
supabase start
supabase db schema declarative generate --local   # scaffold the tree from the clean local DB
```

Even against an empty database this writes the scaffold (`_cluster/`, default schema files,
the export manifest), which is easier to extend than starting from nothing. Alternatively, skip
the generate: running `sync` in a TTY with no `supabase/schemas/` offers to generate first —
dogfood whichever entry point you'd naturally reach for, and note which one you tried.

Author your schema declaratively:

```sh
mkdir -p supabase/schemas/public/tables
cat > supabase/schemas/public/tables/employees.sql <<'SQL'
CREATE TABLE public.employees (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  age SMALLINT
);
SQL
```

Generate the first migration and apply it locally:

```sh
supabase db schema declarative sync --name initial_schema
# → review the printed SQL, confirm the apply prompt (or pass --apply / --no-apply)
supabase migration list --local       # the new version shows locally
```

Apply it to the remote project:

```sh
supabase link --project-ref <ref>
supabase db push --dry-run            # review what would run
supabase db push                      # creates supabase_migrations.schema_migrations, applies
supabase migration list               # local and remote match
```

**Dogfood focus:** does the generated `initial_schema` migration match what you wrote (naming,
identity columns, constraint names)? Is the sync prompt flow (name prompt → SQL review → apply
prompt) pleasant? Did `--dry-run` output tell you enough before the real push?

---

## Scenario 3 — Day-to-day iteration loop

**Starting point:** Scenario 1 or 2 completed. This is the loop users will live in; run it a
few times with different kinds of edits.

1. Edit the declarative tree — try at least: adding a column, changing a default, adding an
   index, creating a function + trigger, adding an RLS policy, dropping a column.
2. `supabase db schema declarative sync` — name it, review the SQL, apply locally.
   - Removals from the tree are **removals from the database**: the tree is the complete
     desired state. Verify drop statements come with a visible warning.
   - `-f <stem>` sets the filename stem (default `declarative_sync`); `--name` overrides it;
     `--apply` / `--no-apply` skip the prompt (mutually exclusive).
3. Exercise your app / studio against the local stack.
4. `supabase db push` to promote to staging, `supabase migration list` to confirm.
5. Occasionally: `supabase db reset` and confirm the migration chain still replays from zero,
   then `sync` again → `No schema changes found`.

Also in this loop, drop a hand-written statement pg-delta doesn't model (e.g. a comment-only
script or a `SECURITY LABEL`) into `supabase/schemas/_custom/` and confirm a subsequent
`generate --overwrite` leaves it alone.

**Dogfood focus:** SQL quality per change type, shadow-database latency per sync (try
`SUPABASE_SHADOW_CACHE=1` and compare warm-run times), and whether repeated syncs stay
zero-diff (no oscillating formatting or ordering churn between runs).

---

## Scenario 4 — Remote drift: someone changed staging behind your back

**Starting point:** Scenario 1/2 completed and clean. Now simulate a teammate: open the
staging dashboard SQL editor and make a change the repo doesn't know about, e.g.
`ALTER TABLE public.employees ADD COLUMN email TEXT;` plus a new index.

Detect it:

```sh
supabase db diff --linked
```

`db diff` compares a shadow built from `supabase/migrations` against the remote — the dashboard
change should show up. (Declarative files are _not_ part of the diff baseline; that's `sync`'s
job.)

Resolve it — recommended path (migration-first):

```sh
supabase db pull dashboard_drift                       # captures drift as a migration, updates history
supabase db schema declarative generate --linked --overwrite   # refresh the tree to match
supabase db schema declarative sync                    # expect: No schema changes found
supabase db reset                                      # local replays the new migration
```

Alternative path worth dogfooding once (declarative-first): `supabase db pull --declarative`
updates **only** the tree (no migration, no history). A following `sync` then generates the
migration from the tree — but remote already has those changes, so do **not** `db push` it;
mark it instead with `supabase migration repair <version> --status applied`. Note how awkward
or natural this felt compared to the recommended path — that's exactly the feedback we need.

**Dogfood focus:** did `db diff --linked` describe the drift accurately? Did the pulled
migration + regenerated tree converge to zero on the first try? How many commands did drift
resolution take, and which ones would a user fail to guess?

---

## Scenario 5 — Local drift: I experimented directly on my local database

**Starting point:** clean checkout, local stack running. Simulate prototyping: open local
studio (or `psql`) and create a table / tweak a column directly, bypassing the tree.

**Path A — keep the changes.** Snapshot the running local DB into the tree, then produce the
migration:

```sh
supabase db schema declarative generate --local --overwrite   # tree now matches local reality
supabase db schema declarative sync --no-apply --name keep_local_experiments
supabase db reset                                             # prove the chain replays from zero
supabase db schema declarative sync                           # expect: No schema changes found
supabase db push                                              # promote when happy
```

(`--no-apply` because the local DB already has the changes — applying the migration on top of
itself would fail. The `db reset` is the real verification.)

**Path B — discard the changes.**

```sh
supabase db reset      # recreates the local DB from migrations + seed; experiments are gone
```

**Dogfood focus:** the `generate --local` prompt behavior (it snapshots the _running_ database
and should say so), whether the overwrite confirmation is clear, and whether Path A's
no-apply/reset dance is understandable without reading this doc.

---

## Scenario 6 — Migration history drift and repair

**Starting point:** any linked project. Manufacture a mismatch, e.g. create a local-only
migration you never pushed (`supabase migration new orphan` with some SQL), or delete a local
file that remote history still records.

```sh
supabase migration list
```

You should see the discrepancy (entries present on one side only). Repair:

```sh
# remote has an entry your local files no longer have → delete the remote record:
supabase migration repair <version> --status reverted

# remote is missing an entry for a migration already applied out of band → insert it:
supabase migration repair <version> --status applied

supabase migration list       # both columns aligned again
```

If you fully reset history (all entries reverted), finish with a fresh `supabase db pull` and
confirm the declarative tree still converges (`generate --linked --overwrite` + `sync`).

**Dogfood focus:** is `migration list` output enough to figure out _which_ repair to run? Do
the repair confirmations protect you from repairing the wrong version?

---

## Scenario 7 — Fresh clone: a teammate joins the project

**Starting point:** a git repo produced by Scenario 2/3 (config, `supabase/schemas/`,
`supabase/migrations/`), cloned onto a machine with none of your local state.

```sh
supabase start                # brings up the stack, applies migrations on the fresh volume
supabase db schema declarative sync     # expect: No schema changes found
supabase link --project-ref <ref>
supabase migration list       # local matches remote
```

**Dogfood focus:** zero-surprise onboarding — the clone should converge with no writes. Time
the first `sync` on a cold machine (shadow images pulled, no caches) and note it: this is the
first impression every new teammate gets.

---

## Scenario 8 — Squash a long migration history

**Starting point:** Scenario 3 run enough times to accumulate ~10+ migrations.

```sh
supabase migration squash --local     # folds history into the latest migration file
supabase db reset                     # squashed chain must replay cleanly
supabase db schema declarative sync   # expect: No schema changes found
```

Remote history still lists the old versions; align it with `migration repair` (revert the
squashed-away versions, mark the squash version applied), then `supabase migration list` to
confirm. Remember squash drops data-manipulation statements (seeds, cron jobs, vault secrets) —
check whether anything you relied on silently disappeared.

**Dogfood focus:** does the squashed file still converge against the declarative tree? Was the
repair choreography discoverable?

---

## Scenario 9 — Review-only diffs with `--from` / `--to`

Explicit endpoint mode always uses pg-delta, regardless of gates. Useful spot-checks:

```sh
supabase db diff --from migrations --to linked    # what remote has that migrations don't
supabase db diff --from local --to linked         # local stack vs staging
supabase db diff --from linked --to migrations --output review.sql
```

This output is a **flattened review artifact, not an apply script** — transactional units can
carry `SET LOCAL` preambles and mixed transaction semantics that only the migration runner
preserves. Confirm the CLI communicates that clearly; to produce something applicable you go
through `db diff -f <name>` (normal target mode) or `sync`.

**Dogfood focus:** readability of the flattened output, correctness of the direction semantics
(from → to), and whether the "don't pipe this into psql" caveat is visible enough.

---

## Scenario 10 — Upgrading a legacy declarative export

**Starting point:** a tree produced by an old pg-delta export — no `.pgdelta-export.json`
manifest (simulate by deleting the manifest and flattening the tree, or reuse a real old
project). Also relevant: trees living in the former default `supabase/database/` directory
should trigger a stderr warning explaining the move to `supabase/schemas/`.

Run `supabase db schema declarative sync`. Expect the compatibility gate:
`This <declarative-dir> tree looks like a legacy pg-delta export.` with an evidence block and a
staged-upgrade recipe. In a TTY it offers to generate the staged export (recommended) and — when
the gap is only `pgcrypto` / `uuid-ossp` / `pg_net` — an in-place `extension.sql` repair.
Non-interactive runs (including `--yes`) must stop without modifying anything.

Staged upgrade:

```sh
supabase db schema declarative generate --local --output-dir supabase/schemas-next
# review schemas-next/, then adopt it (the gate prints the exact rm/mv recipe for your platform)
supabase db schema declarative sync    # expect: No schema changes found
```

**Dogfood focus:** the gate's evidence block (does it justify itself?), the printed recipe
correctness for your platform, and that nothing was mutated before you consented.

---

## Scenario 11 — Escape hatches and debugging

Exercise these deliberately at least once, since they're what support will reach for:

- **Fall back to migra:** `supabase db diff --use-migra`, `supabase db pull --diff-engine migra`,
  or `enabled = false` under `[experimental.pgdelta]`. Confirm the fallback works and note any
  output differences worth flagging in release notes.
- **Strict coverage:** rerun a sync/diff/pull with `--strict-coverage` on a schema that provoked
  coverage warnings — warnings should become hard failures.
- **Cache bypass:** `supabase db schema declarative sync --no-cache` after a warm run; compare
  results (must be identical) and timing.
- **Empty-result debugging:** when a pull/diff is unexpectedly empty:

  ```sh
  PGDELTA_DEBUG=1 supabase db pull --db-url "postgresql://postgres:<pw>@db.<ref>.supabase.red:5432/postgres"
  ```

  Check the bundle under `supabase/.temp/pgdelta/` (`source-catalog.json`,
  `target-catalog.json`, `pgdelta-stderr.txt`, redacted `connection.txt`). Add
  `SUPABASE_SSL_DEBUG=true` for TLS tracing without disabling SSL.

- **Engine implementation toggle:** `SUPABASE_USE_PG_DELTA_NEXT=false` switches to the legacy
  edge-runtime pg-delta path (no automatic fallback). Only worth a run if you're chasing a
  divergence between the two implementations.

---

## Filing what you find

For every rough edge, file an issue with: the scenario number, the exact command sequence, the
generated SQL (or debug bundle for empty results), and whether the convergence check (`sync` →
`No schema changes found`) held. Convergence failures and destructive SQL emitted without a
warning are the highest-priority findings; prompt/wording confusion is still worth filing —
this workflow is about to be the default experience.

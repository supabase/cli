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
- The CLI built from this repo (`bun src/legacy/main.ts …` from `apps/cli/`, or `pnpm dev:legacy`,
  or a released binary). Note `src/supabase.ts` does not exist — the legacy shell's entrypoint is
  `src/legacy/main.ts`.

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
(`public/tables/<table>.sql`, `public/schema.sql`, plus `types/`, `views/`, `functions/`,
`sequences/` as needed), cluster-level objects under `_cluster/` (e.g. `_cluster/roles.sql`), and
an export manifest `.pgdelta-export.json`. The export never writes to or prunes `_custom/` —
that directory is yours for hand-authored SQL pg-delta does not model.

Note on `_cluster/`: the manifest records a `scope`, and a `--db-url` export against a plain
database comes back with `"scope": "database"` and no `_cluster/` directory at all. Check the
manifest's `scope` before concluding that missing cluster files are a bug.

Do not trust the manifest's `loadOrder` as an apply order — see finding F1 in the run log below.

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

---

# Run log — first dogfooding pass

Findings below come from an actual pass over these scenarios. Each finding states what was run,
what happened, why it hurts in a user's hands, and a suggested fix. Everything marked
**Confirmed** was reproduced against a live Postgres; everything marked **Not verified** was
blocked by the environment (see "What this pass could not cover").

## What this pass could not cover

Two environment limits blocked the remote and container-backed halves of the matrix. Neither is a
CLI defect, but both bound the confidence of this run:

- **Staging Management API unreachable.** `api.supabase.green` is denied by the egress policy
  (HTTP 403 on CONNECT). Anything routed through the platform — `link`, `--linked`, `db push`
  against a project, `migration list/repair` against remote history — could not run.
- **Container images unpullable.** All three registries (`public.ecr.aws`, `ghcr.io`,
  `docker.io`) return 403 on blob fetch, so no image can be pulled. That blocks every path that
  provisions a shadow or the local stack: `supabase start`, `db reset`, `db schema declarative
sync`, migration-mode `db pull`, `generate --local/--linked`, and `db diff --linked/--local/
--from migrations`.

To dogfood anyway, the pass used a **native PostgreSQL 16 server** as the target and drove the
shadow-free code paths: `db diff --from <url> --to <url>`, `db schema declarative generate
--db-url`, and `db pull --declarative --db-url`. These exercise the real pg-delta engine
(planning, rendering, export) — just not the shadow provisioning around it.

**Worth knowing regardless of environment:** `generate --db-url` and `db pull --declarative
--db-url` need no Docker at all. That is a genuinely fast path for exporting a declarative tree
from any reachable database, and it is not called out anywhere in the command docs.

## Scenario status

| #   | Scenario                        | Status                                                                                    |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Adopt on an existing project    | Partial — declarative export half confirmed; `link`/`db pull` migration mode not verified |
| 2   | Greenfield, declarative-first   | Partial — `init` and `db push` confirmed; `start`/`sync` not verified                     |
| 3   | Day-to-day iteration loop       | Partial — diff/export quality confirmed; `sync` loop not verified                         |
| 4   | Remote drift resolution         | Partial — drift diff confirmed via two live DBs; remote half not verified                 |
| 5   | Local drift resolution          | Not verified (needs local stack)                                                          |
| 6   | Migration history repair        | **Confirmed** — ran end to end against a live database                                    |
| 7   | Fresh clone onboarding          | Not verified (needs local stack)                                                          |
| 8   | Squash a long history           | Not verified (needs local stack)                                                          |
| 9   | Review-only diffs               | **Confirmed** — ran end to end                                                            |
| 10  | Legacy declarative tree upgrade | Partial — former-default warning confirmed; staged upgrade not verified                   |
| 11  | Escape hatches & debugging      | Partial — `format_options` and gates confirmed; `--no-cache`/`PGDELTA_DEBUG` not verified |

## Findings

### F1 — The export manifest's `loadOrder` is not a valid apply order (high)

**Scenarios 1, 2, 3.** Export any schema where a table depends on a function — a column default
calling one, or the near-universal `updated_at` trigger — and the generated
`.pgdelta-export.json` lists the table file _before_ the function file, because functions are
sorted last as a category.

Minimal reproduction:

```sh
psql -c "CREATE FUNCTION public.gen_code() RETURNS text LANGUAGE sql IMMUTABLE AS \$\$ SELECT 'x' \$\$;"
psql -c "CREATE TABLE public.items (id INT PRIMARY KEY, code TEXT NOT NULL DEFAULT public.gen_code());"
supabase db schema declarative generate --db-url "$URL"
# manifest loadOrder: public/schema.sql, public/tables/items.sql, public/functions/gen_code.sql
```

Replaying the tree in its own declared `loadOrder` fails:

```
FAILED [public/tables/items.sql]
ERROR:  function public.gen_code() does not exist
```

The same happens with a trigger (`ERROR: function public.set_updated_at() does not exist`).

**Why it's bad:** `loadOrder` is published in the manifest as the tree's apply contract, and it is
wrong for one of the most common Supabase patterns. Anything outside the CLI that trusts it — a
CI step, a `psql -f` loop, another tool, or a human reading `tables/items.sql` and wondering
where `set_updated_at` comes from — breaks. It also makes the tree look untrustworthy in review.

**Scope of impact:** the CLI's own `sync` passes `reorder: true` to pg-delta
(`legacy-pgdelta-next-adapter.layer.ts`), so its shadow load very likely re-orders internally and
survives. That was not verifiable here (needs a shadow container), so this is reported as a
manifest-contract defect, not as "sync is broken."

**Suggestions:** make the emitted `loadOrder` a real topological order over cross-file
dependencies rather than a fixed category order; failing that, either drop `loadOrder` from the
manifest or document it explicitly as "informational, not an apply order — the tree must be
loaded through pg-delta, which reorders." Add a test that replays every exported fixture tree in
`loadOrder` against a clean database.

### F2 — Destructive plans are emitted with no warning and exit 0 (high)

**Scenarios 4, 5, 9.** Diffing toward a target that lacks objects produces drops with no banner,
no count, and a success exit code:

```sh
supabase db diff --from "$FULL" --to "$EMPTIER"
# DROP POLICY / DROP TRIGGER / DROP INDEX / DROP VIEW / DROP FUNCTION
# ALTER TABLE ... DROP COLUMN "body" / "m" / "title"
# DROP TABLE ... / DROP TYPE ...
# exit: 0
```

**Why it's bad:** drift resolution is exactly where users get the direction backwards, and
`--from`/`--to` gives no hint which side is the desired state (the help text is just "Diff from
local, linked, migrations, or a Postgres URL"). The output is a wall of SQL where three
data-destroying `DROP COLUMN`s look no different from an index rename. `sync` warns about drop
statements; `db diff` does not.

**Suggestions:** print a destructive-change summary to stderr before the SQL ("⚠ 9 destructive
statements: 3 DROP COLUMN, 2 DROP TABLE, 1 DROP TYPE …"), and expand the `--from`/`--to` help to
state the direction plainly ("`--to` is the desired state; the plan transforms `--from` into
it"). Consider a `--allow-destructive` gate for the file-writing modes.

### F3 — Image-pull failure produces a ~15 KB unreadable error (high)

**Scenarios 2, 3, 5, 7, 8, 11 — any Docker path.** With registries unreachable, the failure is
reported as every attempt from every registry concatenated into one message: 3 registries × 3
attempts, each embedding a full multi-thousand-character presigned CloudFront URL. Each attempt
is printed once as it happens and then _again_ in the final error.

**Why it's bad:** the actionable content is one line ("could not pull
`supabase/postgres:17.6.1.165`"), and it is buried in pages of signed URLs that scroll the real
context off screen. Anyone behind a corporate proxy, a VPN, an air-gapped runner, or a registry
outage hits this, and it floods CI logs. It reads like a CLI crash rather than "your machine
cannot reach the registry."

**Suggestions:** collapse to one line naming the image and the registries tried, with per-attempt
detail behind `--debug`; strip query strings from registry URLs in error text; do not re-print
attempts that were already streamed.

### F4 — Flattened `--from/--to` output has no unit boundaries and misleading preambles (medium)

**Scenario 9.** Plans that cross a transaction boundary are rendered as one flat stream. The only
sign of a second unit is a blank line and a repeated `SET local check_function_bodies = off;`.
Applied the two obvious ways:

```
psql -1 -f plan.sql   → ERROR: unsafe use of new value "ecstatic" of enum type mood   (exit 3)
psql -f plan.sql      → WARNING: SET LOCAL can only be used in transaction blocks (×2)  (exit 0)
```

**Why it's bad:** two problems in one artifact. The docs warn not to apply this output directly,
but the artifact itself carries no marker, so a user who pipes it into `psql -1` gets a confusing
enum error with no clue that the plan was meant to be two transactions. And in the mode that does
succeed (autocommit), `SET LOCAL` is a no-op — so `check_function_bodies = off` never takes
effect, and its protection against forward references silently is not there.

**Suggestions:** emit unit boundaries as SQL comments (`-- unit 2/2 — must run in a separate
transaction`), and either emit `SET` rather than `SET LOCAL` when rendering flattened review
output or wrap each unit in explicit `BEGIN`/`COMMIT`. Repeat the "not a portable apply script"
caveat as a comment header in the output itself, not only in the docs.

### F5 — Non-interactive `generate` over an existing tree is a silent no-op with exit 0 (medium)

**Scenarios 1, 4.** With a tree already present and no TTY:

```sh
supabase db schema declarative generate --db-url "$URL"
# stderr: Overwrite declarative schema? Existing files may be deleted. [y/N]
# stderr: Skipped writing declarative schema.
# exit: 0
```

**Why it's bad:** a CI job that regenerates the tree reports success while changing nothing, and
the drift it was supposed to catch stays invisible. It is also inconsistent with `sync`, which
fails with exit 1 in the same non-interactive situation.

**Suggestions:** in non-interactive mode, fail with exit 1 and a message naming `--overwrite`
(or `--yes`), matching `sync`'s behavior. At minimum, exit non-zero when the command was asked to
write and wrote nothing.

### F6 — `-f/--file` is silently ignored in `--from/--to` mode (medium)

**Scenario 9.** `supabase db diff --from A --to B -f my_migration` prints the diff, creates no
migration file, warns nothing, and exits 0.

**Why it's bad:** the user explicitly asked for a file. Silence plus exit 0 means they find out
later, when the migration they thought they had is missing. The behavior _is_ documented in the
flag's own help ("Ignored with `--from`/`--to`"), which makes this a runtime-feedback gap rather
than a documentation gap.

**Suggestion:** warn on stderr when `-f` is passed with `--from`/`--to`, pointing at the normal
target mode that does write a file. Rejecting the combination outright would be defensible too.

### F7 — Foreign files inside managed directories survive `--overwrite` and become desired state (medium)

**Scenarios 3, 4.** A file dropped into a managed directory (`public/tables/stale_leftover.sql`)
survives `generate --overwrite` untouched. Pruning itself works correctly for objects the export
manages: dropping `public.set_updated_at()` from the database and re-exporting did remove
`public/functions/set_updated_at.sql`.

**Why it's bad:** the declarative tree is defined as the complete desired state, so a leftover
file in a managed directory is not inert — `sync` will read it and try to make the database match
it. A half-renamed file or a stray copy silently resurrects an object.

**Suggestion:** either prune unrecognized `.sql` files in managed directories under `--overwrite`,
or warn that they were found and will be treated as desired state. `_custom/` correctly stays
untouched and is the right home for hand-authored SQL — that part works as documented.

### F8 — Exported "declarative" files read as incremental scripts (low)

**Scenarios 1, 3.** A column whose default calls a function is emitted as a trailing `ALTER`
rather than inline:

```sql
CREATE TABLE "public"."items" (
  "id"         integer                  NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "items_pkey" PRIMARY KEY (id)
);
...
ALTER TABLE "public"."items"
  ADD COLUMN "code" text NOT NULL DEFAULT public.gen_code();
```

**Why it's bad:** the promise of declarative schemas is that a file reads as the desired state.
Here the column list is incomplete and the reader has to scan for `ALTER`s to reconstruct the
table. It also makes hand-editing error-prone — the natural edit (add the column to the
`CREATE TABLE`) conflicts with what the exporter regenerates.

**Suggestion:** inline column definitions whenever the dependency is already satisfied earlier in
the load order; reserve the trailing-`ALTER` form for genuine cycles, with a comment saying why.

### F9 — Inconsistent rendering: some statements bypass the formatter (low)

**Scenarios 1, 3, 9.** In the same plan, most statements are quoted and formatted while indexes
and views come out raw:

```sql
ALTER TABLE "public"."posts" ADD COLUMN "body" text;              -- quoted, formatted
CREATE INDEX posts_partial ON public.posts USING btree (title)    -- unquoted, catalog form
CREATE VIEW "public"."post_titles" WITH (security_invoker=true) AS  SELECT id,
    title
   FROM public.posts;                                             -- raw viewdef, double space
```

**Why it's bad:** this lands verbatim in migrations and declarative files that humans review. Two
identifier-quoting conventions and two indentation styles in one file look like a bug and make
diffs noisier than the change warrants.

**Suggestion:** route index and view definitions through the same renderer as everything else
instead of passing `pg_get_indexdef` / `pg_get_viewdef` output through.

### F10 — Docs contradict each other on the default keyword case (low)

`db/diff.md` and `db/pull.md` say the formatter defaults to **uppercase** keywords;
`db/schema/declarative/sync/SIDE_EFFECTS.md` says it "defaults to **lowercase** SQL at width 180".
Observed default output is uppercase, so `SIDE_EFFECTS.md` is the wrong one.

**Why it's bad:** `SIDE_EFFECTS.md` is treated as the precise contract for the command, so a
contradiction there undermines the file people consult when output looks off.

**Suggestion:** fix the `sync` SIDE_EFFECTS line to say uppercase, and state the full default set
(`keywordCase: upper`, `indent: 2`, `maxWidth: 180`) in exactly one place that the others link to.

### F11 — The config template's `format_options` example is not the default (low)

`supabase init` writes this commented line:

```toml
# format_options = "{\"keywordCase\":\"upper\",\"indent\":2,\"maxWidth\":80,\"commaStyle\":\"trailing\"}"
```

`maxWidth` is 80 there, but the documented and observed default is 180.

**Why it's bad:** it reads as "here is the default, uncomment to edit." Uncommenting it silently
reflows every generated file to a narrower width, producing a large unrelated diff the user did
not ask for.

**Suggestion:** make the example match the real default, or label it explicitly as a non-default
sample.

_(Verified working alongside this: `format_options = "null"` correctly emits single-line raw
statements, a custom `{"keywordCase":"lower"}` correctly lowercases and column-aligns, and invalid
JSON fails with the clear `Invalid config for experimental.pgdelta.format_options: must be valid
JSON`.)_

### F12 — The gate message says "add" when the section already exists (low)

With `[experimental.pgdelta] enabled = false` present in config:

```
declarative commands require --experimental flag or pg-delta enabled in config
Either pass --experimental or add [experimental.pgdelta] with enabled = true to supabase/config.toml
```

**Why it's bad:** the user already has the section; following the advice literally means adding a
duplicate key. The one-word fix they actually need (`false` → `true`) is never stated.

**Suggestion:** branch the message — "set `enabled = true` under `[experimental.pgdelta]`" when
the section exists, "add …" when it does not.

### F13 — `init` enables pg-delta but leaves no signpost to declarative schemas (low)

**Scenario 2.** `supabase init` writes `[experimental.pgdelta] enabled = true` and creates
neither `supabase/schemas/` nor `supabase/migrations/`. The only hint about where declarative
files go is a commented `declarative_schema_path` line at line ~412 of a 15 KB config file.

**Why it's bad:** if declarative is to be the default experience, a fresh project should show
where schema files belong. As it stands the greenfield user has to already know the command name
to discover the workflow.

**Suggestion:** create `supabase/schemas/` at init with a short `README.md` or a
`_custom/.gitkeep`, and mention `db schema declarative generate` in the init success output.

### F14 — Non-SSL connection error does not suggest the fix (low)

`--db-url` against a server without SSL fails with `tls error (The server does not support SSL
connections)` and no remedy. Adding `?sslmode=disable` works.

**Why it's bad:** self-hosted and local-container Postgres commonly run without TLS. The user is
told what failed but not the one-parameter fix.

**Suggestion:** append "append `?sslmode=disable` to the connection string if the server does not
use TLS" to that error.

### F15 — Flag-conflict messages read as generated grammar (low)

```
if any flags in the group [apply no-apply] are set none of the others can be; [apply no-apply] were all set
```

**Suggestion:** "`--apply` and `--no-apply` cannot be used together." Same for
`[declarative diff-engine]`.

### F16 — `db diff`'s "known to fail" list is stale for pg-delta (informational)

`db/diff.md` lists views with `security_invoker` among cases where diffing "is known to fail".
pg-delta handled a `security_invoker = true` view correctly, both in a diff plan and in the
declarative export.

**Suggestion:** scope that list to the migra engine, or re-test each entry against pg-delta and
drop the ones it now handles. Leaving stale limitations in the docs makes users avoid a workflow
that works.

### F17 — `migration fetch` silently destroys local edits (high)

**Scenarios 1, 6.** A migration file edited locally after being pushed is overwritten with the
copy stored in the remote history table — silently:

```sh
echo "-- IMPORTANT local edit" >> supabase/migrations/20240101000000_initial_schema.sql
supabase migration fetch --db-url "$URL"
# stderr: Do you want to overwrite existing files in supabase/migrations directory? [Y/n]
# stderr: Connecting to remote database...
# exit: 0
```

The appended line is gone afterwards. The command names no file, reports no count, and says
nothing about what it changed.

**Why it's bad:** three problems compound. The prompt defaults to **yes**, so a non-interactive
or piped run overwrites without anyone answering. The prompt fires _before_ connecting, so the
user is asked to approve an overwrite the CLI cannot yet describe. And nothing is reported
afterwards, so the loss is invisible until someone notices the file changed in `git diff` — or
does not notice at all. Comments, formatting, and any post-push edit are lost.

**Suggestions:** list the files that will be written and ask after connecting, not before; report
what was written and skipped; default the prompt to **no**; skip files whose content already
matches; and require `--yes`/`--overwrite` to proceed non-interactively rather than assuming
consent.

### F18 — Non-interactive prompt defaults run opposite to risk (medium)

**Scenarios 1, 2, 4.** With no TTY, the two commands take opposite defaults, and the dangerous
one is the permissive one:

| Command                          | Prompt                                         | Non-interactive default | Effect                                    |
| -------------------------------- | ---------------------------------------------- | ----------------------- | ----------------------------------------- |
| `db schema declarative generate` | `Overwrite declarative schema? … [y/N]`        | **No**                  | writes nothing, exit 0 (F5)               |
| `migration fetch`                | `… overwrite existing files … [Y/n]`           | **Yes**                 | overwrites local files (F17)              |
| `db push`                        | `Do you want to push these migrations … [Y/n]` | **Yes**                 | applies migrations to the target database |

**Why it's bad:** the safe, local, reversible operation (writing schema files) refuses to act,
while the two that mutate a remote database or destroy local files proceed unattended. That is
backwards, and it makes the CLI's non-interactive contract unpredictable — a user cannot reason
about what a scripted Supabase command will do without checking each one.

**Suggestion:** pick one rule and apply it everywhere — the defensible one is that any prompt
that mutates a remote database or overwrites files must fail without `--yes` when there is no
TTY. `db push` in CI is common enough that changing it is a compatibility decision, but the
asymmetry should at least be documented in one place.

### F19 — "reverted" suggests a schema rollback that never happens (medium)

**Scenario 6.** After repairing a migration that added a column:

```sh
supabase migration repair 20240102000000 --status reverted --db-url "$URL"
# Repaired migration history: [20240102000000] => reverted
```

The column that migration added is still present:

```
psql -c "\d employees"  →  age, id, name
```

**Why it's bad:** "reverted" is the vocabulary of undoing a change. The command only deletes a row
from `supabase_migrations.schema_migrations`; the schema is untouched. A user repairing history to
"undo" a bad migration will believe the change is gone, and the next diff or pull will then report
drift they do not understand.

**Suggestion:** say what actually happened — "Removed migration history record [20240102000000].
The schema itself was not changed." The flag name can stay for compatibility; the output does not
have to reinforce the wrong mental model.

### F20 — `migration list` emits literal backticks in non-TTY output (low)

Piped or redirected, the table renders as:

```
   Local            | Remote           | Time (UTC)
  ------------------|------------------|-----------------------
   `20240101000000` | `20240101000000` | `2024-01-01 00:00:00`
   ` `              | `20240102000000` | `2024-01-02 00:00:00`
```

**Why it's bad:** the backticks are markdown styling that never got rendered, and empty cells come
out as `` ` ` ``. Anyone grepping or parsing this in CI has to strip them, and it reads as a
rendering bug.

**Suggestion:** strip the markdown styling when stdout is not a TTY, the same way the spinner is
suppressed for machine formats.

## What worked well

Worth recording, because these are the load-bearing behaviors:

- **Convergence held.** Both a simple diff and a complex one (enum, `security_invoker` view,
  trigger, RLS policy, partial index, table comment) applied cleanly and re-diffed to empty.
- **Transaction-boundary awareness is real.** `ALTER TYPE ... ADD VALUE` was correctly placed in
  its own unit, ahead of the `ADD COLUMN ... DEFAULT 'ecstatic'::public.mood` that depends on it.
  `psql -1` failing on the flattened form (F4) is the proof the split was necessary.
- **Object coverage is broad.** Enums, `security_invoker` views, trigger functions, RLS enable +
  policy, partial indexes, comments, sequence ownership and grants were all rendered.
- **Pruning works.** Dropping a function from the database and re-exporting removed its file.
- **`_custom/` is respected** exactly as documented — never written, never pruned.
- **The former-default warning is a model error message.** It names what was found, what changed,
  and both ways out:

  ```
  WARNING: found declarative schema files in supabase/database, but the default declarative
  directory is now supabase/schemas.
  Set declarative_schema_path = "./database" under [experimental.pgdelta] in supabase/config.toml
  to keep using the existing tree, or move it to supabase/schemas.
  ```

- **`--use-pg-delta` deprecation** on `db pull` prints a clear pointer to `--declarative`.
- **The migration-history mismatch guard is excellent.** `db pull` refuses to run against a
  database whose history does not match local files, and hands over the exact fix:

  ```
  The remote database's migration history does not match local files in supabase/migrations directory.

  Make sure your local git repo is up-to-date. If the error persists, try repairing the migration
  history table:
  supabase migration repair --status applied 20260826032843
  ```

- **Scenario 6 works end to end.** `migration list` showed drift in both directions (a remote-only
  row and a local-only row), `migration repair --status reverted` removed the right record, the
  list came back aligned, and a following `db push` applied only the still-missing migration.
- **`db push --dry-run`** lists exactly the migrations it would apply and changes nothing.
- **Agent/JSON output mode** is correctly auto-detected and cleanly separated from human text
  output; human mode renders errors on stderr with the `--debug` hint.

## Suggested next pass

Run the same matrix in an environment with registry access and a reachable staging project. The
highest-value unverified checks, in order:

1. Whether `sync` tolerates the F1 `loadOrder` problem in its shadow load (`reorder: true`
   suggests yes) — and whether an externally-authored tree with the same shape is refused.
2. The Scenario 1 convergence check on a real project: `db pull` → `generate --linked` → `sync`
   must print `No schema changes found`.
3. Grant noise on a real project, where `anon`, `authenticated`, and `service_role` exist —
   `GRANT ... TO "postgres"` was emitted for every table here, and whether that stays stable
   against a real Supabase ACL baseline is unknown.
4. `--strict-coverage` against a schema with objects pg-delta cannot model.
5. Shadow timings cold vs. warm, with and without `SUPABASE_SHADOW_CACHE=1`.

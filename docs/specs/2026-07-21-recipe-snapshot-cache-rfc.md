# Recipe-Keyed Snapshot Cache for Local Databases — RFC

- **Status:** draft RFC — sections marked **[hypothesis]** are pending Phase 0 measurements (`2026-07-21-snapshot-cache-phase0-spike.md`)
- **Date:** 2026-07-21
- **Supersedes:** `2026-07-21-pg18-instant-database-clones.md` (kept as exploration record)
- **Companion:** fleet runtime design in [PR #5819](https://github.com/supabase/cli/pull/5819) (`docs/specs/2026-07-07-micro-supabase-stacks-design.md`) — this RFC proposes an extension of that design and should be reviewed together with it

## Abstract

Local database provisioning cost — `db reset`, shadow databases for `db diff`, test fixtures — is believed to be dominated by replaying user migrations and seeds, not by copying bytes. **That dominance is the central hypothesis Phase 0 Gate 1 exists to test.** If it holds, this RFC proposes a **recipe-keyed snapshot cache**: materialize the database state produced by a given recipe (migrations + seeds + flags) once, then reuse it via copy-on-write filesystem snapshots.

PGDATA-level snapshots provide full-cluster fidelity and serve reset and shadow. Database-level templates inside a running cluster serve only explicitly constrained DB-local fixtures, and are optional. PostgreSQL 18's `file_copy_method = clone` can accelerate the latter, but it does not define the architecture; no PG18-specific code is planned for the first ship.

> Full-cluster fidelity is a PGDATA snapshot problem; DB-local fixtures are optional and may never need PG18.

Snapshot reuse is an intentional semantic change from today's always-replay behavior. Whether its measured speedup justifies that change and the cache's lifecycle costs is the question the spike's kill criteria decide.

## Dependencies

1. **PGDATA snapshot/restore primitives in `@supabase/stack`** — quiesce/suspend, CoW clone with copy fallback, atomic publication, restore. These are a subset of the machinery in draft [PR #5819](https://github.com/supabase/cli/pull/5819); Phase 1 (shadow) is blocked on them landing in some form. This RFC does **not** depend on the fleet daemon itself (see §3.2 for daemon-absent operation).
2. **A new CLI↔stack orchestration boundary.** Fleet templates today stop at service-warm: user migrations and seeds are replayed by the CLI (currently through the legacy Go seam), not by the stack, and current `db reset` is not integrated with fleet. Build topology: the CLI provisions an **ephemeral scratch stack, runs the recipe fresh, asks the stack to snapshot and publish the result, then discards the scratch stack**. That boundary does not exist yet and is part of this RFC's cost, not an incidental detail.
3. **No dependency on PostgreSQL 18** (§3.5) and no dependency on any particular filesystem — CoW accelerates, fallback copy degrades, nothing breaks.

## 1. Problem

- `db reset` replays every migration and seed on every invocation; cost grows with project history. Agent-driven workflows (worktrees, fix loops, test setup) reset often, which motivates this work — though since the fast path is opt-in (§2), agent-side wins are adoption-gated.
- `db diff` builds a shadow database by replaying all migrations in a disposable environment, every diff.
- Test suites that want real-Postgres fixtures pay the same replay cost per isolated database.

The fleet runtime removes the *platform* share of this cost via base and service-warm templates. The user's own migrations and seeds still replay every time; caching that layer is this RFC — at the price of the new orchestration boundary described in Dependencies.

## 2. Vocabulary and semantic modes

A **recipe** is the full set of inputs that determine the materialized database state:

- parent template tier (see §3.1 — e.g. service-warm for reset recipes; a thinner parent such as base/PG-only where the consumer needs no services),
- Postgres and service versions (inherited from the parent tier's key),
- ordered migration file contents,
- seed file contents,
- behavior-affecting flags and config (`--no-seed`, `--version`, schema/SQL paths, relevant environment inputs; for linked `db diff`, any remote-derived baseline/config merged into the shadow — **[open]** exact input list needs a flag/config audit).

Recipe serialization must be **canonical**: paths canonicalized relative to the project root, no absolute paths, no worktree-specific `PWD` or incidentally-resolved config — otherwise worktree cache sharing (§3.4) silently never hits. This is a tested invariant (spike L9).

The recipe key is a hash of these inputs. A recipe key is a **memoized-build key, not a content address**: migrations and seeds are unrestricted SQL and may be volatile (`now()`, `random()`, generated UUIDs, external effects), so identical recipes can produce different artifacts. A cache hit returns *whichever artifact was built first*, which is sticky — not deterministic and not reproducible across machines.

Three semantic modes, which the design must never blur:

| Mode | User SQL behavior | Semantic status |
|---|---|---|
| **Fresh execution** | Migrations and seeds always replayed | Current reset fidelity — today's contract |
| **Recipe snapshot** | Exact recipe key reuses previously materialized state | Faster; intentionally sticky |
| **Snapshot lineage** | Existing snapshot incrementally extended (e.g. appended migrations) | Most complex; greatest divergence — **out of scope for v1** |

Decisions:

- **Fresh execution remains the default for `db reset`.** Enabling recipe-snapshot mode is an explicit opt-in (flag and/or `config.toml`), because it changes the command's observable contract. Whether it should later become the default for agent-oriented flows is a product decision to make in the open, informed by Phase 0.
- **Shadow caching is opt-in experimental in Phase 1** — cached shadows also freeze volatile migration behavior, so `db diff` semantics must not change silently. Stated intent: flip to default-with-`--fresh`-bypass once E1 parity evidence exists, because shadow output is regenerable and low-risk relative to reset — it is where snapshot semantics earn trust first.
- The escape hatch from a cached snapshot is a **full bypass** (`fresh`): rerun everything. There is no seed-only refresh in v1 — that requires a migration-only snapshot tier (snapshot-lineage adjacent) and is deferred.
- Snapshot lineage is rejected for v1: reset ordering is migrations-then-seeds, so appending a migration onto a seeded snapshot executes a different program. A future migration-only tier could revisit this with documented divergence.

## 3. Design

### 3.1 Template tiers

The fleet design has two tiers; this RFC names and adds a third:

```
base (pg version)  →  service-warm (service version tuple)  →  project-warm (recipe key)
```

- **base / service-warm** — unchanged, as specced in PR #5819.
- **project-warm** — PGDATA snapshot taken after fresh execution of a recipe on top of its declared parent tier. Keyed by recipe hash. Private to a project (§3.4).

### 3.2 Ownership (provisional — reviewers please confirm)

- **`@supabase/stack`** owns the mechanical primitives, usable without the fleet daemon: quiesce/suspend Postgres, snapshot PGDATA, atomic publication, restore-from-snapshot.
- **The CLI** owns recipe definition and hashing (it knows migrations, seeds, flags, config) and decides when to build, reuse, or bypass.
- **Store invariant — one store, one lock protocol:** the cache store is a **fixed project-owned location** with a single on-disk lock protocol, coordinated by whichever process is acting (CLI directly, or the fleet daemon when present). The daemon adds supervision — cross-project size-aware GC, crash recovery of abandoned builds — it never introduces a second store or lock domain, so daemon startup mid-build changes nothing about in-flight builds (tested: spike L8).

### 3.3 Consumers and their layers

| Consumer | Layer | Rationale |
|---|---|---|
| Shadow database for `db diff` (**first consumer, Phase 1, opt-in experimental**) | Dedicated scratch cluster provisioned from a project-warm PGDATA snapshot (shadow recipe: migrations, no seeds, special GUCs e.g. `max_worker_processes=0`) | Today's shadow is a separate cluster with unrestricted SQL; a shared long-lived cluster would regress isolation. **Phase 1 entry requires both:** (a) end-to-end diff-output parity — `contrib_regression`, declarative-schema mode (second database), remote-merged config for linked projects, identical output across engines (migra, pg-delta); and (b) **material end-to-end savings on both hit and miss paths** (spike E1). Direct `--db-url` diff targets are **excluded from the first rollout** (always fresh path). Ships without storage snapshots. Validates the recipe cache, not database-granularity cloning |
| `db reset` fast path (opt-in) | PGDATA project-warm snapshot, restored via fleet `resetPod`-style suspend/restore | Only PGDATA restore resets roles, `_supabase`, slots, cluster GUCs — matching today's cluster-recreate semantics. **Phase 1 entry gates:** (a) storage-directory semantics decided after auditing what current reset actually does to storage; (b) restore choreography for slots and service restarts specified (today's reset restarts services deliberately) |
| DB-local test fixtures | In-cluster `CREATE DATABASE ... TEMPLATE` clones | **Deferred** until measured demand (Phase 0 Gate 2). Contract is explicitly constrained: recipes with cluster-global side effects (roles, cluster GUCs, slots) are unsupported on this layer — the escape hatch is a dedicated scratch cluster or PGDATA restore, since rebuilding a database in-place does not purge cluster-global mutations |

### 3.4 Cache lifecycle

- **Identity and privacy:** cache entries are keyed by the tuple **(project namespace, recipe key, cache-schema version)**. Recipe keys alone must never resolve across projects: volatile SQL and seeded secrets mean a colliding recipe from another project could serve foreign data. Cache directories are owner-only (0700); cross-project isolation is a tested invariant, not a convention. Snapshots retain data blocks of deleted content (including seeded secrets), so the cache is sensitive, project-private state — excluded from backups/sharing by default. **[open]** namespace derivation: candidates are `project_id` from config, the linked project ref, or a config-content hash. A *path-derived* namespace forbids cache sharing across git worktrees of the same project; a *project-identity-derived* one allows it (sharing volatile artifacts within one project is the acceptable case, and worktrees are the motivating workload). Leaning project-identity.
- **Cache-schema versioning:** the schema-version component invalidates all entries across incompatible CLI/stack upgrades; no in-place migration of snapshots.
- **Build:** on cache miss, run fresh execution, then snapshot (topology in Dependencies §2). Miss cost = fresh execution + snapshot publication — *no worse than today plus one copy*, where the copy is cheap only on confirmed CoW filesystems. **[hypothesis:** publication cost on CoW and fallback filesystems — Phase 0 measures both.**]**
- **Durability and integrity model — rebuildable cache, not durable store:** every artifact is rebuildable from its recipe, so the design buys *integrity detection + rollback* rather than full data durability. Publication: build into a temp path, write a **checksum manifest**, publish atomically (rename, with publication metadata fsynced — full data fsync is not required; worst case is a detected-corrupt entry that becomes a cache miss).
- **Restore transaction:** restore never commits before Postgres health validation. Sequence: (1) preserve the old PGDATA (rename aside, not delete); (2) install the candidate snapshot; (3) start Postgres and run integrity/health queries; (4) on success, commit by removing the backup; (5) on failure, stop, restore the backup, restart, and mark the cache entry corrupt. Note: the draft fleet implementation removes the backup before waking Postgres — that ordering discovers corruption too late and must not be inherited here.
- **Invalidation:** any recipe input change → new key → miss. No in-place mutation of published snapshots.
- **Concurrency:** per-key build lock; concurrent misses on the same key coalesce (one builds, others wait or fall back to fresh execution). **[hypothesis:** right timeout/fallback policy.**]**
- **GC — required for Phase 1, not conditional:** shadow alone needs bounded PGDATA-cache storage, so accounting/eviction is a Gate 1B deliverable (extended, not introduced, by Gate 2). Size-aware with a real CoW accounting model — logical sizes double-count shared extents, and physical ownership shifts when snapshots are deleted. Readers/builders take **leases** on snapshots so GC cannot remove an entry mid-clone.
- **Capability detection:** there is currently **no reliable CoW probe** in the codebase (`cp --reflink=auto` succeeds silently after a plain copy). Phase 0 designs mechanism-specific probes (spike P1): PGDATA directory cloning and PostgreSQL's own `copy_file_range`/`copyfile` path get separate capability results — one does not imply the other. On non-CoW filesystems the cache still functions with real copy costs; features must degrade, never break.

### 3.5 PostgreSQL 18 acceleration (appendix-level, not v1)

PG18's `file_copy_method = clone` makes `CREATE DATABASE ... STRATEGY = FILE_COPY` a CoW operation — relevant only to the deferred DB-local fixture layer (§3.3, row 3). Positioning:

- **No PG18-specific code in the first ship.** The copy step in the fixture layer (if it ships) is a pluggable engine: `WAL_LOG` → `FILE_COPY` → `FILE_COPY` + session-scoped `SET file_copy_method = clone` on the maintenance connection when running on ≥18 with verified CoW.
- Gating facts: `supabase/postgres` has no PG18 build (checked 2026-07-21; all `-cli` tags are 17.6.x); `CREATE DATABASE ... TEMPLATE` copies neither database-level GUCs nor ACLs (must be reapplied post-clone); `FILE_COPY` forces cluster-wide checkpoints (concurrency impact is a Gate 2 measurement).
- The kill criterion for PG18 work lives on the first page of the Phase 0 spike doc. Killing PG18 work does not shrink this RFC: the cache is the project; PG18 is one possible copy engine for its smallest layer.

## 4. Out of scope

- Intra-cluster full-stack branching (database-per-worktree with service routing) — rejected by the micro-stacks design for isolation reasons; would require a separate service-routing RFC. Worktree branching is fleet `forkPod`.
- Snapshot lineage / incremental templates (§2).
- Seed-only refresh (§2).
- Storage-object snapshotting for **shadow** — shadow has no storage semantics and ships without it. For **reset**, storage is not out of scope: it is a Phase 1 entry gate (§3.3).
- Direct `--db-url` diff targets (first rollout; always fresh path).

## 5. Open questions

1. Ownership confirmation (§3.2), including the store location choice for the fixed project-owned store.
2. Recipe hash completeness: exact list of config/env/remote inputs that affect materialized state (flag audit; linked `db diff` remote baseline).
3. Project-namespace derivation (§3.4 candidates) and worktree cache sharing.
4. Storage directory semantics for snapshot-mode reset, after auditing current behavior (§3.3).
5. Replication-slot and service-restart choreography after PGDATA restore (§3.3; spike P3).
6. Should recipe-snapshot mode ever become the default for reset in agent contexts, and with what surfacing? (Product decision, post-Phase 0. Shadow's opt-in→default path in §2 is the trust-building precedent.)
7. Expected exact-recipe hit rate in real workflows — the cache is worthless if recipes usually change between uses; Phase 0 G1.6 estimates this and the break-even reuse count.

## 6. References

- Exploration record: `2026-07-21-pg18-instant-database-clones.md` + review thread (five rounds, two reviewers)
- [PR #5819 — micro stack fleet runtime](https://github.com/supabase/cli/pull/5819)
- [PostgreSQL `CREATE DATABASE`](https://www.postgresql.org/docs/18/sql-createdatabase.html) (template GUC/ACL non-copy, `FILE_COPY` checkpoints)
- [`file_copy_method`](https://pgpedia.info/f/file_copy_method.html) (PG18, session-settable)
- [boringSQL — Instant database clones with PostgreSQL 18](https://boringsql.com/posts/instant-database-clones/) (single-system benchmark, not a general guarantee)

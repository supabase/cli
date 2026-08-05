# PG18 Instant Database Clones — Exploration Spec

> **Superseded.** Kept as the exploration record. The review loop concluded that the durable opportunity is a recipe-keyed snapshot cache, with PGDATA snapshots for fidelity cases and PG18 as an optional copy engine for a deferred fixture layer. See `2026-07-21-recipe-snapshot-cache-rfc.md` (design) and `2026-07-21-snapshot-cache-phase0-spike.md` (measurements + kill criteria). Several claims below did not survive review — notably U1's reset-parity framing, "content-addressed" naming, and the incremental-template idea.

- **Status:** superseded exploration record (was: exploration / pre-RFC)
- **Date:** 2026-07-21
- **Origin:** [Slack thread in #initiative-dev-dx](https://supabase.slack.com/archives/C0AB27PLABA/p1784590694815179) (Paul Copplestone, via Matt Linkous), follow-up idea by Andrew Valleteau: "could be very, very useful for agents worktrees"
- **Primary reference:** [Instant database clones with PostgreSQL 18](https://boringsql.com/posts/instant-database-clones/)
- **Related:** [PR #5819 — micro stack fleet runtime](https://github.com/supabase/cli/pull/5819), `docs/specs/2026-07-07-micro-supabase-stacks-design.md` (in that PR), Slim CLI initiative

## 1. What the feature is

PostgreSQL 18 adds a new GUC, `file_copy_method`, which controls how `CREATE DATABASE ... STRATEGY = FILE_COPY` (and `ALTER DATABASE ... SET TABLESPACE`) copies data files:

- `copy` (default) — userspace read/write loop, byte-for-byte copy.
- `clone` — uses `copy_file_range()` on Linux/FreeBSD and `copyfile()` on macOS. On copy-on-write filesystems the kernel shares block ranges instead of copying them: the clone is metadata-only, near-instant, and consumes no additional disk space until pages diverge.

```sql
-- postgresql.conf: file_copy_method = clone
CREATE DATABASE my_branch TEMPLATE postgres STRATEGY = FILE_COPY;
```

Reported benchmark from the reference article: cloning a **6 GB** database takes **~67 s** with the default `WAL_LOG` strategy vs **~212 ms** with `FILE_COPY` + `clone` on a CoW filesystem — O(1) in database size, zero extra storage at clone time.

### Constraints and caveats

1. **No active connections to the template database** during the clone (a long-standing `FILE_COPY`/template restriction). The source must be idle for the duration of the (now ~instant) copy.
2. **`FILE_COPY` forces checkpoints** (before and after). Cheap for local dev sizes, and our micro profile already runs `fsync = off`.
3. **Single filesystem/tablespace** — cloning cannot cross tablespaces on different filesystems.
4. **CoW filesystem required for the speedup**: APFS (macOS default), Btrfs, XFS with reflink (Linux ≥ 4.5), ZFS. On non-CoW filesystems (notably **ext4**, the common Linux default) the kernel degrades to an in-kernel copy — still correct, not instant. Behavior must be probed, not assumed.
5. **Not usable on managed cloud databases** (RDS, Cloud SQL — no GUC/filesystem control). This is a *local/self-hosted-first* capability, which is exactly our niche.
6. Cluster-scoped objects are shared, not cloned: roles, replication slots, `shared_preload_libraries`, and per-cluster GUCs like `cron.database_name`. A cloned database is a new database *inside the same cluster*.

## 2. Why this matters for us

The Slim CLI initiative removes Docker and runs Postgres as a native binary we fully control (`packages/stack/src/services/postgres.ts`, native mode). That is precisely the position needed to exploit this feature: we set the GUCs, we own the data directory, we choose where it lives on disk, and we already ship a pinned Postgres build (`packages/stack/src/versions.ts` — currently 17.6.1.143).

Cloud providers cannot offer this. A local-first CLI can — it turns "database branch" from an infrastructure feature into a sub-second local primitive, which is the core promise of the agentic local dev story (many agents, many worktrees, many disposable databases, one laptop).

## 3. Relationship to the fleet runtime (PR #5819)

The fleet runtime already implements copy-on-write cloning — **one level below Postgres**. `cowClone.ts` clones the entire pod data directory via APFS `clonefile -Rc` / `cp --reflink=auto`, and `forkPod()` snapshots a pod after a brief clean suspend. PG18 cloning operates **inside a running cluster**. They are complementary granularities, not competing designs:

| | Fleet `forkPod` (exists today, PG17) | PG18 `CREATE DATABASE ... STRATEGY=FILE_COPY` |
|---|---|---|
| Unit cloned | Whole pod: PGDATA + services + config | One database within a cluster |
| Postgres version | Works on 17 | Requires 18 |
| Downtime | Brief suspend of source pod | Terminate connections to source **DB** only; cluster stays up |
| Incremental memory cost | One more pod (Postgres + full service set) | Zero — same Postgres instance |
| Isolation | Full: own ports, own roles, own services, own extensions | Shared cluster: roles, slots, cluster GUCs shared |
| Service wiring | Free — each pod is a complete stack | Services must be pointed at the new database (they assume `postgres` today) |
| Filesystem dependency | Same (CoW for speed, fallback copy) | Same (CoW for speed, fallback copy) |

Practical reading: **fleet fork is the right primitive when a branch needs a full isolated stack** (its own API URL, auth, storage). **PG18 clone is the right primitive when only the database state needs to fork or reset** — which covers several high-frequency CLI operations that don't need new service instances at all. The capability probe the fleet already needs ("does this data dir support reflink?") is the same probe that predicts whether PG18 clone is instant.

## 4. Use cases in the CLI

Ordered by leverage-to-effort. The first three require **no multi-database awareness in services** — they use clone-and-swap or throwaway databases, preserving the single-`postgres`-database assumption.

### U1 — Instant `db reset` (highest leverage)

Today `db reset` drops user schemas, re-runs every migration, then seeds (`apps/cli/src/legacy/commands/db/reset/reset.handler.ts:316` → `db __db-bootstrap`). Cost grows with migration/seed volume; on large projects this is tens of seconds to minutes, and it's one of the most-executed commands in agent loops.

With PG18: maintain a pristine template database (`_supabase_template_<hash>`) built once per (migrations + seed + PG version) tuple — exactly the fleet's warm-template hash concept, applied intra-cluster. Reset becomes:

```sql
-- terminate connections, then:
DROP DATABASE postgres WITH (FORCE);
CREATE DATABASE postgres TEMPLATE _supabase_template_<hash> STRATEGY = FILE_COPY;
```

Sub-second reset regardless of migration count. Services already survive connection loss (fleet suspend/wake proves the reconnect path). First reset after a migration/seed change pays full price to rebuild the template; every subsequent reset is ~free.

### U2 — Instant shadow database for `db diff` / pg-delta

Schema diffing creates a shadow database by replaying all migrations, every diff. Cloning the same pristine template gives a ready shadow database in milliseconds, and `DROP DATABASE` disposes of it. This compounds with pg-delta ("diffing 2.0") — the diff engine gets cheaper *and* its setup gets ~free.

### U3 — Ephemeral test databases

Integration/e2e harnesses (ours and our users') get integresql-style semantics: clone a seeded template per test file/suite, run, drop. Test parallelism stops being gated on database setup time. This could ship as a documented pattern or a small `supabase test db` helper.

### U4 — Agent worktree database branches (the original thread idea)

Each git worktree / agent session gets its own database branch cloned from the current dev state:

```
supabase db branch create feature-x     # clone postgres -> feature-x, instant
supabase db branch switch feature-x     # repoint services / connection string
```

Two implementation shapes:

- **Pod-per-worktree (available now, PG17):** fleet `forkPod` — full isolation, costs one pod per branch. This is the already-specced path.
- **Intra-pod branches (PG18):** N branches share one Postgres instance and one service set — near-zero marginal memory, instant creation, no suspend. Requires services to route to a per-branch database (PostgREST/auth/realtime/storage all currently assume one database), which is the expensive part — see D6.

A pragmatic hybrid: worktrees keep fleet pods for full-stack isolation, but PG18 clone makes each pod's *internal* forks/resets instant, and DB-only branches (agent just needs a Postgres connection string, not a full API) can be intra-pod.

## 5. What it would take

### D1 — PG18 build (gating, external)

`supabase/postgres` has **no PG18 release yet** — all current `-cli` Nix builds are 17.6.x (checked 2026-07-21). Options: (a) wait for/coordinate an upstream 18 build with the Postgres team; (b) experiment with vanilla PG18 from nixpkgs for benchmarking only (baseline migrations may need supabase-specific extensions, so this only supports Phase 0). This is the long pole; everything else is CLI-side work.

### D2 — Config + capability probe

- Add `file_copy_method = clone` to the micro/local config profile (18-only GUC; must be version-gated).
- Probe at stack init whether the data-dir filesystem gives CoW semantics (the fleet's reflink probe already answers this). Persist the result as a stack capability.
- Fallback ladder for clone operations: `FILE_COPY`+`clone` (instant) → `FILE_COPY`+`copy` → `WAL_LOG` (or today's full re-run path). Every feature built on cloning must remain *correct* on ext4, just slower — degraded, never broken.

### D3 — Connection-drain primitive in `packages/stack`

A small helper effect: `withQuiescedDatabase(name, fn)` — `ALTER DATABASE ... ALLOW_CONNECTIONS false` → `pg_terminate_backend` for remaining sessions → run `fn` (clone/drop/rename) → re-allow. Needed by U1/U2/U4; also generally useful (e.g. today's reset already fights lingering connections).

### D4 — Template lifecycle

- Template naming/keying by content hash of (PG version, service migrations, user migrations, seed files) — direct reuse of the fleet warm-template tuple design, intra-cluster.
- Build on first use, invalidate on hash change, GC stale templates (they're ~free on CoW disk, but clutter `\l` output).
- Templates created with `ALLOW_CONNECTIONS false` so they're always clonable.

### D5 — CLI surface

- `db reset`: use the template path automatically when capabilities allow (fast path is the default, not a flag).
- `db diff`: shadow DB from template.
- New (Phase 3): `db branch create|list|switch|delete` for local intra-pod branches, integrated with the worktree story.

### D6 — Multi-database service awareness (only for U4-intra-pod)

PostgREST, auth, realtime, and storage each pin a database/connection. Realtime additionally needs per-database replication slots; `pg_cron` runs in a single configured database per cluster. Making the service set branch-aware (or spawning per-branch lightweight service configs) is a significant, separate design. **U1–U3 deliberately avoid this entirely.**

## 6. Phasing

- **Phase 0 — Benchmark spike (no product change):** vanilla PG18 + micro profile on APFS and ext4/btrfs; measure clone latency vs DB size, checkpoint cost with `fsync=off`, connection-drain edge cases. Validates the numbers before committing upstream asks.
- **Phase 1 — Fast reset + fast shadow (U1, U2):** D2–D5 minus branching. Ships user-visible wins ("reset in 200 ms") with zero service-layer changes. Gated on D1.
- **Phase 2 — Test-database helper/pattern (U3):** thin layer over Phase 1 primitives.
- **Phase 3 — Local DB branching for worktrees (U4):** converge with the fleet runtime — decide pod-per-branch vs intra-pod-per-branch per use case; tackle D6 if intra-pod wins.

## 7. Open questions

1. **PG18 timeline in `supabase/postgres`** — is a Nix 18 build planned? Does the platform's own PG18 rollout schedule align? (Owner to ask: Postgres team.)
2. **Docker mode** — data dir lives in a named volume inside the Docker Desktop VM; is the backing filesystem CoW-capable there? (Native mode is the priority; Docker mode may only ever get the fallback path.)
3. **Storage objects** — file objects on disk are outside the database; do reset/branch semantics need to snapshot the storage directory too (fleet CoW clone of the storage dir would pair naturally)?
4. **Realtime replication slots** — after a clone-and-swap reset, does realtime's slot need explicit recreation? (Likely yes; today's reset presumably handles an equivalent situation.)
5. **Windows** — no reflink support in NTFS via this mechanism (and PG's `clone` method targets Linux/macOS/FreeBSD syscalls); Windows/WSL2-ext4 stays on the fallback path. ReFS is untested territory.
6. Is `DROP DATABASE postgres` + recreate acceptable vs rename dance (`postgres_new` → swap)? Drop-then-create has a window with no `postgres` DB; rename requires the same quiescing. Phase 0 should pick one.

## 8. References

- boringSQL — [Instant database clones with PostgreSQL 18](https://boringsql.com/posts/instant-database-clones/)
- pgPedia — [`file_copy_method`](https://pgpedia.info/f/file_copy_method.html)
- PostgreSQL commit — [Introduce file_copy_method setting](https://www.postgresql.org/message-id/E1u25N2-003GyZ-1O@gemulon.postgresql.org)
- [PR #5819 — feat(stack): add micro stack fleet runtime](https://github.com/supabase/cli/pull/5819) (CoW templates, `forkPod`, warm-template tuple hashing)
- Slack: [original thread](https://supabase.slack.com/archives/C0AB27PLABA/p1784590694815179)

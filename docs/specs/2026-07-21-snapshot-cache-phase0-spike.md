# Snapshot Cache — Phase 0 Measurement Plan

- **Status:** executable spike plan — this document leads; the companion RFC (`2026-07-21-recipe-snapshot-cache-rfc.md`) keeps its **[hypothesis]** sections open until these results land
- **Date:** 2026-07-21
- **Structure:** Gate 1 proves (or kills) the cache's primary PGDATA consumer and is internally split — **Gate 1A** is pure benchmarking (cheap, days), **Gate 1B** builds lifecycle prototypes and the shadow integration only if 1A is promising. **Gate 2** runs the broader mechanism matrices only if Gate 1 passes. This keeps Gate 1 from becoming a mini Phase 1 and avoids validating PG18's deferred niche before the cache itself is proven.

## Decision structure (read first)

Three separate decisions with separate inputs — a shadow-parity failure must not veto a working cache, and a fast cache must not ship a shadow with no real win:

| Decision | Inputs | Bar |
|---|---|---|
| **K2 — cache viability** | G1.1–G1.3, G1.6, P1(a), must-have lifecycle results (L1, L3, L5, L7) | Hit ≥5× vs fresh execution at the committed decision fixture F3, with absolute savings in seconds; miss path within ~1.2× of fresh execution **on CoW filesystems** (a user-experience ceiling, not an amortized-cost claim); on fallback filesystems a documented degrade policy (warn / cache-off / opt-out) decided by amortized cost at measured hit rates — a fallback miss penalty does not auto-fail K2 |
| **Shadow Phase 1 entry** | E1 | Full diff-output parity (scope below) **and** material end-to-end savings on both hit and miss paths |
| **K1 — PG18** | Gate 2 (if reached) | If PG17-level copying and PGDATA snapshots cover the fidelity cases, implement no PG18-specific code now; keep the copy engine pluggable, revisit when a `supabase/postgres` PG18 build exists *and* measurements justify it. Killing PG18 work kills PG18 work only |

The ≥5× / ~1.2× bars are proposals — reviewers may move them, but only before results exist.

---

## Gate 1A — benchmarks (cheap; run first)

### G1.1 Fixture corpus (defines the decision fixture so K2 is falsifiable)

Final database size is not a proxy for replay cost — one bulk `COPY` and 1,000 DDL migrations can produce same-sized databases with radically different timings. The corpus varies replay-cost drivers independently:

| Fixture | Migrations | Migration style | Seed | Approx final size |
|---|---|---|---|---|
| F1 | 10 | simple DDL | small SQL | ~10 MB |
| F2 | 50 | mixed DDL/DML | moderate | ~100 MB |
| **F3 — committed decision fixture** | 200 | mixed, incl. slow ones (indexes, backfills) | moderate | ~100 MB |
| F4 | 50 | simple DDL | bulk `COPY` heavy | ~1 GB |
| F5 | 200 | mixed | bulk heavy | ~1 GB |

F3 is a **committed bar chosen before results exist, not a measured percentile** — whether it matches the real P50 project is itself checked by G1.6's sampling. Where possible, mirror 1–2 fixtures from real project shapes. For every fixture, record fresh-execution replay time P50/P90, cold and warm filesystem cache. This directly tests the RFC's central hypothesis (replay cost dominates copy cost).

### G1.2 PGDATA hit path

PG17, micro profile. Snapshot restore (suspend → clone data dir → restart) vs fresh execution, per fixture, on **APFS** (CoW representative) and **ext4** (fallback representative). Also validates the fleet draft's 100–300 ms restart figure, currently a design target, not a measurement.

### G1.3 Miss path

Fresh execution **plus snapshot publication** (temp build → checksum manifest → atomic rename with metadata fsync), per fixture, both filesystems. Full data fsync is not part of the model (rebuildable cache — see RFC §3.4); measure manifest+rename overhead explicitly.

### G1.6 Break-even and hit-rate analysis (provisional in 1A, refined in 1B)

- Break-even reuse count per fixture: publication overhead ÷ per-hit savings. A 10× hit improvement is irrelevant if recipes normally change before the second use.
- Estimate real-world exact-recipe hit rates: instrument the spike prototype during dogfooding (log recipe keys per reset/diff), and sample real project git histories for how often migration/seed/flag inputs change between consecutive resets. Crude is fine; zero data is not. This also feeds the fallback-filesystem degrade decision in K2.

### P1(a) — PGDATA CoW capability probe

Per-file `FICLONE` ioctl (Linux) / `copyfile` clone flags (macOS) on a test file *in the target cache directory*; validate by verifying shared allocation and post-clone divergence, then benchmark the actual directory clone — small-file latency classification alone is noisy. Explicitly not `cp --reflink=auto` (succeeds silently after a plain copy) and not fs-name sniffing.

**Gate 1A checkpoint:** if F3 hit-vs-fresh is nowhere near the K2 bar, or break-even looks unreachable at plausible hit rates, stop here and report — no lifecycle work.

---

## Gate 1B — lifecycle prototypes + shadow integration (only if 1A is promising)

### Lifecycle experiments

**Must-have for K2** (prototype-level proof the invariants are achievable — not production hardening):

- **L1** — builder killed mid-publication → no partial snapshot ever visible; next build recovers.
- **L3** — concurrent same-key misses coalesce (one builds, others wait or fall back to fresh execution) without deadlock.
- **L5** — cross-project isolation: identical recipe in two projects never shares an artifact; cache dirs owner-only (0700). (Simple two-directory check is sufficient at this stage.)
- **L7** — single-store locking behaves sanely under two concurrent CLIs on one project.

**Sketch / Phase 1 design inputs** (demonstrate the approach, defer depth):

- **L2** — restore transaction: corrupt/truncated snapshot detected via manifest; restore follows preserve-backup → install → boot health validation → commit-or-rollback; restore failure preserves the source database. (The draft fleet flow deletes the backup before waking Postgres — verify the corrected ordering here.)
- **L4** — GC cannot remove a snapshot holding an active reader/builder lease.
- **L6** — cache-schema version bump invalidates all prior entries cleanly.
- **L8** — fleet daemon starting mid-build neither duplicates the store nor breaks the in-flight build (single store, single lock protocol).
- **L9** — canonical recipe serialization: identical recipes in sibling worktrees share; migration/env changes miss; independent repository copies never share; paths canonicalized relative to project root.

### G1.5 E1 — shadow on scratch cluster (decides Shadow Phase 1 entry, not K2)

Prototype `db diff`'s shadow as a scratch cluster provisioned from a PGDATA recipe snapshot. **Entry requires both:**

- **Parity:** end-to-end diff-output parity — `contrib_regression`, declarative-schema mode (second database), local and linked configurations (remote-merged config as a recipe input), across both engines (migra, pg-delta). Direct `--db-url` targets are excluded from the first rollout (always fresh path) per the RFC.
- **Material win:** end-to-end diff latency vs the current disposable-container path must improve materially on **both** hit and miss paths — a cache that only speeds the second diff of an unchanged migration set may not clear this.

### GC accounting (moved from Gate 2 — required for Phase 1)

First-write amplification post-clone; physical vs logical size accounting with shared extents (deletion shifts ownership); reclaim behavior; lease mechanics. **Deliverable: a workable accounting/eviction policy for the PGDATA cache.** Gate 2 extends it to DB-level fixtures and more filesystems; it does not introduce it.

### P3 — Restore choreography

After PGDATA restore: replication slots, pg_cron workers, service pools (auth/storage/realtime/PostgREST). Today's reset restarts services deliberately — enumerate the equivalent restore sequence and its failure modes under live connections. Required input for the reset Phase 1 entry gate.

### P4 — Storage audit

Document what current `db reset` actually does to the storage directory/objects before deciding whether snapshot-mode reset should include it. Do not assume the storage dir should be snapshotted merely because it can be. Required input for the reset Phase 1 entry gate.

### Gate 1 verdict

One-page report: K2 go/no-go, Shadow Phase 1 entry decision, fallback-filesystem degrade policy, lifecycle findings, measured values folded into the RFC's **[hypothesis]** sections.

---

## Gate 2 — mechanism matrices (only if Gate 1 passes and fixture demand exists)

### M1 — DB-level copy latency

Per fixture (or a subset), PG17 vs vanilla-nixpkgs PG18 (no supabase build exists; acceptable for mechanism measurement, noted as a fidelity gap for supabase extensions):

- `CREATE DATABASE ... STRATEGY = WAL_LOG`
- `STRATEGY = FILE_COPY` (`file_copy_method = copy` on 18)
- `FILE_COPY` + session `SET file_copy_method = clone` (18 only)
- Control columns: fresh execution and the Gate 1 PGDATA restore numbers.

### M2 — Filesystem matrix

Extend beyond APFS/ext4: btrfs, XFS+reflink, Docker Desktop VM volume. Record measured behavior class (instant CoW / kernel copy / userspace copy), not filesystem names.

### M4 — Concurrency and interference

The fixture-layer load shape: N parallel clone-create/drop cycles (N = 4, 16, 64) against a cluster serving a foreground workload; foreground latency degradation and checkpoint pressure (`FILE_COPY` forces cluster-wide checkpoints; micro profile, 16 MB `shared_buffers`, `fsync=off`). Go/no-go input for the DB-local fixture layer.

### P1(b) — PostgreSQL copy-path capability

Separate capability result for PG's own `copy_file_range`/`copyfile` path — P1(a) success does not imply it.

### P2 — Swap semantics

Rename-swap vs drop-recreate for in-cluster swaps; `DROP DATABASE ... WITH (FORCE)` behavior with prepared transactions and logical slots present.

### E2 — DB-local fixture feasibility

Not a demand check — fleet's tests already use service-free PGDATA-cloned pods, so this is a mechanism comparison. Measure steady-state mechanisms independently (template sharing, process reuse, clone granularity), then compare end-to-end under identical prebuilt state: in-cluster DB-template fixtures vs PGDATA-cloned pods. Include a **negative fixture containing cluster-global DDL** (`CREATE ROLE`, `ALTER SYSTEM`-adjacent) to demonstrate the documented isolation boundary of the DB-local contract. Internal only; no user-facing surface.

### GC extension

Extend the Gate 1B accounting/eviction policy to DB-level fixtures and the wider filesystem matrix.

### Gate 2 verdict

K1 decision plus the fixture-layer verdict.

---

## Parallel (non-blocking) asks

- PG18 build timeline question to the Postgres team (informs K1's "revisit when" clause; the spike does not wait on it).

## Deliverables

1. Gate 1A: corpus results (fresh/hit/miss per fixture and filesystem), provisional break-even + hit-rate, P1(a) findings, checkpoint decision.
2. Gate 1B: lifecycle findings (must-have + sketches), E1 parity + latency report and the Shadow Phase 1 entry decision, GC accounting/eviction policy, P3/P4 findings, K2 go/no-go page.
3. Gate 2 (conditional): M1/M2/M4 tables with control columns, P1(b)/P2, E2 comparison incl. the negative fixture, GC extension, K1 decision.
4. RFC **[hypothesis]** sections updated with measured values; open questions 4–5 and 7 resolved or narrowed.

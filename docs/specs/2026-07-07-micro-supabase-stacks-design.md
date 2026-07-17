# Micro Supabase Stacks — High-Density Local & Free-Tier Postgres

- **Date:** 2026-07-07
- **Status:** Draft for review
- **Scope:** Postgres first; architecture sized for the full minimal stack (Postgres, PostgREST, Auth, Realtime, Edge Functions)

## Goal

Run 100+ Supabase-compatible Postgres instances in parallel on small machines (8–16GB), for agents working in parallel git worktrees, local development, and very-low-resource free plans. "Compatible" means real upstream Postgres with the complete extension set of `supabase/postgres 17.6.1.143` — no PGlite-style reimplementation, no SQLite backend, no dropped extensions.

## Requirements (agreed)

- **Target environments:** both local dev machines (macOS/Linux) and Linux micro-VMs/containers for cloud free tier, from one shared design.
- **Compatibility bar:** every Supabase extension installable and behaviorally identical via `CREATE EXTENSION`; `shared_preload_libraries` trimmed to near-empty by default (heavy libraries load on demand).
- **Suspend-on-idle is acceptable:** first connection after idle may pay a wake-up latency of tens to hundreds of milliseconds.
- **Scope now:** Postgres and its orchestration. Sidecar services (PostgREST, Auth, Realtime, Edge Functions) are designed for but implemented later; their needs shape Postgres decisions today.
- **Durability:** data is disposable/re-cloneable everywhere (`fsync=off` profile). Recovery from host-crash corruption is "re-clone from template."
- **Density target:** 100+ registered instances on an 8–16GB host, most idle at any moment.
- **Windows:** `supabase start` must work, always via the Docker path (no native Windows service binaries). Windows gets functional parity, not the density optimizations — templates, suspend-on-idle, and the budget guardrails apply to macOS/Linux native pods.

## Non-goals

- Production/paid-tier deployments.
- Postgres major-version in-place upgrades (pods are disposable; reset onto a new base template).
- Windows *native* binaries and Windows density optimizations (`supabase start` still works on Windows via Docker; see Requirements).
- Slimming the sidecar services themselves (tracked as follow-up; see Risks).

## Approach

**Approach A — stock Postgres + aggressive configuration + a host-level orchestrator. No Postgres source patches.**

Rejected alternatives:

- **B — one cluster, database-per-worktree:** cheapest possible, but roles and `ALTER SYSTEM` are cluster-wide, `pg_cron` binds to one database, restart isolation is impossible, and it cannot model free-tier isolation. Kept in the back pocket for pure local agent swarms only.
- **C — patched "micro-mode" Postgres:** a fork of a fork (Supabase already patches Postgres) with every extension becoming a compatibility risk, for gains profiling suggests are small once suspend-on-idle and preload trimming are in place. Revisit only if Approach A hits a measured wall.

Postgres's heavy reputation comes from default configs and Supabase's preload stack, not the engine. Tuned honestly, an idle instance costs ~15–25MB unique memory; suspended, it costs zero.

## Architecture

The deployment unit is a **pod**: one Postgres per worktree/project, with sidecars slotting in beside it later. A host is composed of:

1. **Shared read-only artifacts (per host, not per pod):**
   - One Postgres 17.6 install tree with the full Supabase extension set, built from the `supabase/postgres` Nix package definitions pinned to tag `17.6.1.143` (extension parity guaranteed, Supabase's own patches included, none of ours added). One artifact per platform: `aarch64-darwin`, `x86_64-linux`, `aarch64-linux`. All pods share the code pages.
   - A **template store** (see Templates below).
2. **Per-pod state (cheap):** a copy-on-write clone of a template plus a generated conf overlay and allocated ports.
3. **One fleet daemon per host** — the orchestrator (see Fleet daemon below).

**Suspend/resume operates on the pod as a unit, never on Postgres alone.** Realtime holds a logical-replication connection and PostgREST holds a pool; Postgres napping independently would look like an outage to them. Idle detection watches external traffic at the proxy edge and ignores intra-pod connections.

### How the full-stack goal shapes Postgres decisions now

- `wal_level=logical` with replication slots budgeted (Realtime), not `minimal`.
- `max_connections=40`: ~15 reserved for sidecar pools, ~25 for the user.
- Template pre-seeded with Supabase roles/schemas/baseline migrations so sidecars boot against a fresh clone without setup.
- `max_slot_wal_keep_size` capped so an undrained slot can never eat the disk. Because Realtime stops and starts with the pod, slots never dangle while WAL accumulates.
- Realtime (Elixir/BEAM, ~150–300MB) will dominate a full pod's memory. It is multi-tenant by design; the likely future is one shared Realtime serving all pods. Nothing here blocks either choice — slots are per-instance regardless.

### Per-service lazy start

Scale-to-zero applies at two levels: the pod, and each service within a warm pod.

- The pod manifest declares which services are **enabled** (default: all, for cloud parity). Enabled means "may be started on demand," not "running."
- The gateway routes per path (`/rest/v1`, `/auth/v1`, `/realtime/v1`, `/functions/v1`), so the first request to a service starts exactly that service, health-gates, then forwards. Until then the pod runs without it. Postgres is the only member that always starts on pod wake.
- A request to a never-used service therefore still succeeds — indistinguishable from cloud except for first-request latency (PostgREST/GoTrue fast; Realtime seconds).
- **DB-originated traffic wakes services:** `pg_cron`/trigger-driven webhooks via `pg_net` arrive at the proxy edge and legitimately start/keep-alive services. Consequence (documented, intended): a pod with a scheduled workload never suspends.
- **Max capacity is a testing concern, not a runtime default:** CI verifies the all-services-warm envelope; runtime optimizes for the typical case.

## Postgres build

- Source of truth: `supabase/postgres` Nix package set at `17.6.1.143`, built unchanged, producing a relocatable install tree per platform.
- No size-oriented compile flags or feature stripping (ICU, SSL stay — compat-relevant). Binary size is a per-host cost.
- Locale/collation setup mirrors the Supabase image exactly (provider and `C.UTF-8` defaults) to preserve dump/restore fidelity.
- **First implementation spike:** validate the Nix build of the full extension set on `aarch64-darwin`. Documented fallback: run Linux pods in a lightweight VM on macOS.

## The `micro.conf` profile

Everything not listed stays at PG defaults.

**Memory:**

| Setting | Value | Rationale |
|---|---|---|
| `shared_buffers` | `16MB` | Dev datasets are small; the OS page cache (shared across pods) backs reads; only touched pages cost RSS. |
| `work_mem` | `4MB` | Allocated only while sorting; safe ceiling. |
| `maintenance_work_mem` | `32MB` | Allocated only during vacuum/index build. |
| `jit` | `off` | Never loads LLVM into backends; the single biggest per-backend saving, useless on dev-sized data. |
| `huge_pages` | `off` | Irrelevant at this scale. |
| `max_connections` | `40` | Slots are cheap; only spawned backends (~2–5MB) cost real memory. |

**Background CPU:** `autovacuum_naptime=5min`, `autovacuum_max_workers=1`, `bgwriter_lru_maxpages=0`, `walwriter_delay=10s`, `checkpoint_timeout=30min`, `max_parallel_workers=0`, `max_parallel_workers_per_gather=0`, `max_worker_processes=4` (headroom for on-demand `pg_cron`/`pg_net`/timescale workers), `track_io_timing=off`, minimal logging to a per-pod file.

**Durability (disposable profile):** `fsync=off`, `synchronous_commit=off`, `full_page_writes=off`. Also makes startup/shutdown fast, which suspend/resume relies on. Host-crash corruption recovery: `reset` (re-clone).

**Replication:** `wal_level=logical`, `max_wal_senders=5`, `max_replication_slots=5`, `max_slot_wal_keep_size=256MB`, `wal_keep_size=0`.

### Preload policy: preload on request

`shared_preload_libraries` starts **empty**. Extensions that require preload (`pg_cron`, `pg_net`, `timescaledb`, `pg_stat_statements`, `auto_explain`, `pgaudit`, `plan_filter`, `supautils`, legacy `pgsodium`) are handled by an orchestrator API `ensure-extension-preload <name>`: append the library to the pod's conf overlay, restart that pod's Postgres (sub-second with `fsync=off`), then `CREATE EXTENSION` works. All other extensions (`pgvector`, `pg_graphql`, `postgis`, `pgjwt`, `vault`, …) are plain `CREATE EXTENSION`, zero cost until used. `supautils` (platform role guardrails) is a profile flag: off for local dev, on for free-tier fidelity.

### Config layering

Per-pod `postgresql.conf` = `include micro.conf` (shared, read-only) + generated per-pod overlay (port, socket dir, preloads). User `ALTER SYSTEM` lands in `postgresql.auto.conf` inside the pod's data dir, surviving suspend/resume and matching real-project semantics. Auth via scram with the standard local-dev password, matching Supabase CLI conventions.

## Templates & provisioning

### Pod manifest

Small declarative file stored with the pod (versions illustrative; defaults come from the stack package's version manifest):

```yaml
id: worktree-nifty-dhawan
versions: { postgres: 17.6.1.143, auth: 2.177.0, realtime: 2.34.47, postgrest: 13.0.4, functions: 1.67.0 }
services: { rest: enabled, auth: enabled, realtime: enabled, functions: enabled }
flags: { supautils: off }
```

The `versions` tuple picks binaries, keys the warm-template cache, and tells the runtime what to run.

### Template store (per host)

Each service owns and applies its own migrations at boot (GoTrue → `auth`, Realtime → `realtime`, Storage → `storage`); the Postgres image ships only the baseline. Hence two layers:

- **Base template**, tagged by Postgres image version only (`pg-17.6.1.143`): `initdb` with image-matching locale settings, boot, apply the `supabase/postgres` baseline migrations (roles: `anon`, `authenticated`, `service_role`, `supabase_admin`, …; schemas: `auth`, `realtime`, `storage`, `extensions`; default extensions), clean shutdown, mark read-only. This alone guarantees any combination of service versions can boot against a fresh clone — each service self-migrates exactly as it would against a cloud project.
- **Warm templates**, keyed by the full version-tuple hash, built lazily: on first provision of a new tuple, clone base → boot the full stack once → services self-migrate → shutdown → freeze as a cached template. Subsequent pods with the same tuple skip migration time entirely (first boot drops from seconds to clone cost). Pure optimization — cache miss falls back to the base path. LRU garbage-collected.

**Service upgrades on an existing pod need no template machinery:** bump the manifest tuple; the new service version self-migrates the pod's live data dir on next boot, as in production. Templates matter only at provisioning time; a pod is never re-cloned under a live data directory.

### Provisioning (fast path)

1. Clone template → `pods/<id>/data` via `clonefile` (APFS) / `cp --reflink=auto` (btrfs/xfs) / plain copy fallback (template ~40–50MB, so ~a second worst case).
2. Write the per-pod conf overlay; register pod + ports with the fleet daemon.
3. Done — Postgres doesn't start until the first connection. Provision cost: milliseconds and near-zero bytes.

### Lifecycle operations

- `create` / `destroy` (destroy releases ports, reclaims disk).
- `reset` — re-clone from template; doubles as corruption recovery.
- `fork <source-pod>` — CoW-clone an existing pod's data dir (after a brief clean suspend of the source) into a new pod. Agents branching a worktree get a byte-identical, independently-diverging database branch in milliseconds.
- `upgrade` — edit the manifest tuple; services self-migrate on next boot.

On-disk layout follows the existing `~/.supabase` convention (where the binary cache already lives): `~/.supabase/{templates, pods/<id>/{data, conf, logs, run}}` — a single inspectable, deletable tree.

### Addressing

- **Postgres:** one TCP port per pod from an orchestrator-allocated range (the pgwire protocol has no pre-TLS host routing to exploit).
- **HTTP services:** one shared gateway port, host/path-routed (`<pod-id>.localhost:<port>/rest/v1/…`) — also where lazy start hooks in. On cloud free tier, where pods have their own network identity, the same proxy binds per-pod addresses.
- Connection strings printed by the CLI match Supabase-CLI conventions.

## Orchestrator: evolve `@supabase/stack` + new fleet daemon

`@supabase/stack` (in the Bun CLI monorepo, `packages/stack`) is viable and is kept. It already provides: native-binary resolution with Docker fallback (shared cache at `~/.supabase/bin` — which *is* the shared install tree), dependency-ordered supervision via `@supabase/process-compose`, health-gated readiness, the key-translating API proxy, per-service `startService`/`stopService` (the substrate lazy start needs), port allocation, daemon/connect modes, and parallel-stack E2E tests.

### Division of responsibilities

- **`@supabase/stack` = pod runtime.** "Given a prepared data dir and version manifest, run this stack": ServiceDefs, supervision, health checks, API proxy, per-service start/stop, log streaming.
- **Fleet daemon = new thin host-level layer** owning everything that must exist when pods don't: pod registry and manifests, template store + CoW provisioning + `fork`, persistent port registry, the always-listening network edge, idle timers, wake/suspend policy. Hosts warm pods as in-process `StackHandle`s inside one Bun process. Programmatic TypeScript API (`fleet.create()`, `fleet.wake()`, `fleet.fork()`, `fleet.suspend()`); `supabase start/stop` become thin calls over it.

This replaces the current daemon-per-stack fork model (100 pods must not mean 100 daemons, and a suspended pod must cost zero processes — only a shared daemon holding its port delivers that) and replaces `readReservedPorts()`'s per-create filesystem scan with an owned registry.

### Suspend/resume mechanics

- **Edge:** the fleet daemon permanently binds every pod's Postgres TCP port and the shared HTTP gateway. Postgres traffic is spliced TCP (per-port; negligible overhead for dev). HTTP routes by host/path as ApiProxy does today.
- **Wake:** connection to a suspended pod's port → start Postgres (~100–300ms with `fsync=off`) → forward. First HTTP request to a not-yet-running service on a warm pod → `stack.startService(name)` → health-gate → forward.
- **Idle:** suspend when a pod has no open external connections **and** no bytes flowing for T (per-profile: 5min local dev, 15min free tier). Suspend = `stack.stop()` (graceful, dependency-ordered, already implemented). Live Realtime websockets correctly keep a pod warm; `pg_cron`-driven pods correctly never sleep.
- **Crash handling:** pods run as detached process groups with pidfiles; the fleet daemon **adopts** running pods on restart via liveness checks (the pattern `StateManager` already uses, promoted to fleet level). Daemon crash ≠ database outage. Postgres crash → process-compose restart policy; unrecoverable data dir → `reset`.

### Changes inside `@supabase/stack`

1. **Provision via template clone, not per-boot init:** `postgres-init` reduces to a no-op check; the fleet daemon hands `createProvisionedStack` a pre-cloned data dir and declarative version/service selection. Stack owns the runtime configuration. (Per-boot init can never support `fork`; templates can.)
2. **Micro config profile:** the Postgres service gains the conf-overlay mechanism and an `ensureExtensionPreload(name)` interface that persists the required preload and restarts Postgres when necessary.
3. **Version bump `17.6.1.081 → 17.6.1.143`; native-first hardening.** Roadmap flag (not this project): Edge Runtime is currently Docker-forced; native bundles for remaining services are the ask to service teams — Docker-only services undercut the density story on tiny machines.

Untouched: Effect-based internals, BinaryResolver, health checks, key-translation proxy, log streaming.

## Memory budget, measurement & testing

### Methodology

- **Memory = PSS** (not RSS), summed over the pod's process group: `/proc/<pid>/smaps_rollup` on Linux, `phys_footprint` on macOS. RSS double-counts shared binary pages ~100× across the fleet; PSS attributes them fractionally, which is what actually fills the host.
- **CPU = idle wakeups + %core over 60s** per warm pod (`powermetrics` / `pidstat`). Idle CPU is what melts a laptop at 20 warm pods; Section "Background CPU" settings exist for this number.

### Budget guardrails (per pod, to be validated by the harness)

| State | Memory (PSS) | CPU idle |
|---|---|---|
| Suspended | 0 (manifest on disk only) | 0 |
| Warm, Postgres only | ≤ 30MB | < 0.5% core |
| Typical warm (PG + PostgREST + Auth) | ≤ 120MB | < 1% core |
| Max capacity (all services incl. Realtime + Functions) | ≤ 450MB | measured, documented |

Host math: an 8GB machine holds 100+ registered pods with ~15–20 typical-warm or ~8–10 max-warm concurrent — past the density target. Realtime dominates the full-pod number (see Risks).

### Benchmark harness

A script in the CLI repo: provision N pods, wake a subset, drive synthetic traffic, sample PSS/CPU, assert the table above. Runs in CI so a version bump or config change that blows the envelope fails a build.

### Tests

- **Unit:** port registry, template cache keys (tuple hashing), idle-timer state machine, manifest round-trips.
- **Integration:** base/warm template builds; clone and `fork` divergence (write to fork, source untouched); extension-preload configuration end-to-end; suspend/resume preserves committed data; wake-latency assertions.
- **Compatibility suite (the "no compromise on extensions" proof):** `CREATE EXTENSION` for every extension in `supabase/postgres 17.6.1.143` plus a smoke query each; real CLI migration/seed flows; round-trip fidelity (`pg_dump` from pod → restore into stock image, and vice versa); logical-replication smoke test (create slot, stream changes) standing in for Realtime until sidecars land.
- **Density E2E:** extend `parallelStacks.e2e` — 100 registered pods, wake 10 at random, assert envelope, port uniqueness, clean suspend.
- **Chaos:** `kill -9` fleet daemon → adoption on restart; kill Postgres → supervised restart; simulated host crash → verify documented `reset` recovery.

## Risks & open questions

1. **Nix darwin builds** of some extensions in the `supabase/postgres` set may not compile on `aarch64-darwin`. First implementation spike; fallback is Linux pods in a lightweight VM on macOS.
2. **Realtime memory per pod** (~150–300MB BEAM VM) dominates full pods. Mitigated now by lazy start; the structural fix is one shared multi-tenant Realtime per host — future project, not blocked by this design.
3. **Docker-only services** (Edge Runtime today) undercut density on tiny machines; native bundles are a roadmap ask to service teams.
4. **Windows:** served by the Docker path for functional parity (`supabase start` works); explicitly out of the density story. The fleet daemon must degrade gracefully there — pods run as Docker containers without templates or suspend-on-idle.

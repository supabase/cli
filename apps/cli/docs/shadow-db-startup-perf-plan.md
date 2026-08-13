# Shadow database startup performance — implementation plan

Status: **workstream A implemented; B and C planned**. This document is a handoff spec: it
contains the measured baseline, the agreed design decisions, and file-level work items. An
implementing agent should be able to execute it without re-deriving the investigation.

## Context

`db diff` / `db pull` / declarative sync provision a **shadow database**: a throwaway
`supabase/postgres` container brought to the platform baseline (init schema + realtime /
storage / auth one-shot migration jobs), then handed to pg-delta as the isolated shadow
(`pgdelta … --isolated-shadow`, loader mode `isolatedCluster`). pg-delta requires this
shadow on a **different Postgres lineage** than the target, so the container is on the hot
path of _every_ plan — the migrations-catalog cache cannot make it go away.

Today the shadow is created cold and destroyed (`docker rm -f -v`) on every run.

## Measured baseline

Benchmarked 2026-08-13 on `supabase/postgres:17.6.1.158` (Docker 29, overlayfs, warm image
cache), reproducing the exact container shape `legacyBuildShadowPostgresContainerSpec`
produces (same entrypoint heredoc script, env, healthcheck flags) and the exact one-shot
job env from `db-setup.ts`. Two cold samples, consistent within ~1s:

| Phase                                                                          | Time       |
| ------------------------------------------------------------------------------ | ---------- |
| `docker create` + secret `docker cp` + `docker start`                          | ~0.4s      |
| Postgres accepting connections (initdb + bundled init SQL)                     | ~3.4–4.5s  |
| Docker healthcheck reports `healthy` (**the CLI's current gate**)              | ~10.2s     |
| One-shot realtime job (Elixir boot + tenant seed)                              | ~6.5s      |
| One-shot storage migrate job                                                   | ~2.5s      |
| One-shot auth (`gotrue migrate`) job                                           | ~0.7s      |
| Revoke API privileges + `CREATE DATABASE contrib_regression TEMPLATE postgres` | ~0.3s      |
| **Total cold provision** (excl. image pulls, excl. user migrations)            | **~20.5s** |

Additional measurements that motivate the work items:

- The healthcheck is `interval=10s, timeout=2s, retries=3` with **no
  start_period/start_interval** (`postgres.service.ts`), so Docker's first probe runs at
  t+10s. Postgres is connectable at ~3.5s → **~6.5s per provision is pure dead wait**. The
  same container with `--health-start-period 30s --health-start-interval 1s` reported
  healthy at 3.2s.
- `docker start` of an already-initialized shadow container → connectable in **~1.0s**
  (also ~1s after a SIGKILL'd stop, via WAL recovery).
- `CREATE DATABASE … TEMPLATE <db>` on the baseline state: **~0.2s**. `DROP DATABASE …
WITH (FORCE)`: ~0.1s.
- `docker stop` on the current container takes **10.3s**: the entrypoint is `sh -c "… &&
docker-entrypoint.sh …"`, so PID 1 is `sh`, which does not forward SIGTERM; Docker waits
  the 10s grace period and SIGKILLs.

Target end state: **~1.5–2s** per plan on a warm cache hit; **~14s** cold (health gate
fixed); cold path otherwise unchanged.

## Design decisions (already made — do not relitigate)

1. **This is a CLI-only concern.** pg-delta is not modified and never learns the cache
   exists. Its `isolatedCluster` loader mode already supports a pre-provisioned shadow
   with a platform baseline and pre-existing rows. The deliverable is "set up the base
   `supabase/postgres` container + its owned services faster".
2. **Cache the container, not a volume.** The shadow mounts no volume today (PGDATA in
   container fs, `binds: []`), and Docker has no cheap volume clone. Reuse = keep the
   initialized container **stopped** between runs, `docker start` it on the next plan, and
   prune state with template databases + a role-delta reset.
3. **Invalidate on any input change, never partially refresh.** See cache key below.
4. **Escape hatch everywhere:** any error or anomaly on the warm path (start failure, port
   busy, reset error, missing metadata) ⇒ treat as cache miss: `docker rm -f -v` the
   container and cold-provision. Worst case is today's behavior; the cache can never
   produce a wrong baseline.
5. **Readiness fix uses a direct connect probe, not `--health-start-interval`.** That flag
   requires Docker Engine 25+/API 1.44 and is not reliably supported by Podman (the CLI
   falls back to Podman via `spawnContainerCli`). A connect probe sidesteps the
   runtime-version matrix. (`docker-create-args.ts` already supports
   `--health-start-period` if a flag-based variant is ever wanted, but it alone does not
   speed up the first probe.)
6. Timing is **not** part of the Go-parity surface (ADR 0016) — these are TS-side
   improvements. Do not change stdout text, exit codes, or flag surfaces.

## Cache key (workstream C)

Hash (sha256, stable field order) of every input baked into the cluster during cold
provisioning:

- resolved `supabase/postgres` image tag (full tag, e.g. `17.6.1.158` — _not_ major
  version) after registry/pin resolution;
- resolved one-shot job image tags — `realtime`, `storage`, `auth` via
  `legacyResolvePinnedImage` + `serviceVersionOverrides` — each included **only when its
  service is enabled** (a disabled service's job never ran into the baseline);
- service enabled flags themselves (realtime/storage/auth);
- `jwtSecret`, `rootKey`, `[db] password`, `db.settings` (serialized), `jwtExpiry`;
- effective `api.auto_expose_new_tables`;
- `supabase/roles.sql` contents (empty string when absent);
- `[db.vault]` secret **names and values** (values are upserted into the DB — the existing
  `setupInputsToken` in `legacy-pgdelta.cache.ts` hashes names only, which is
  insufficient here; do not reuse it as-is, but mirror its hashing style);
- `shadowPort` (the stopped container's port binding is fixed at create time);
- `db.major_version` (implied by the image tag in practice, but cheap and explicit).

Note: the existing `setupInputsToken` also omits the service image tags. That may or may
not matter for the catalog cache (out of scope here — flag it to a human if touched); for
the container cache it definitely matters, because the jobs write versioned schema state
(`auth`, `storage`, `_realtime`) into the cluster.

## Workstream A — shadow readiness gate (independent, ship first) — IMPLEMENTED

Shipped as `legacyWaitForShadowReady` in
`apps/cli/src/legacy/shared/db-bootstrap/health-check.ts`, consumed by
`legacyPrepareRawShadow` (`shadow-database.ts`) and `legacyPrepareShadowSource`
(`commands/db/shared/legacy-shadow-source.ts`). Two shadow health-waits deliberately stayed
on the Docker-health gate and are follow-up candidates: `db diff --use-pgadmin`
(`diff.handler.ts`) and `migration squash` (`squash.handler.ts`) — both provision the same
shadow container and pay the same ~6.5s. The spec below is retained as the record of what
was agreed.

**Problem:** `legacyPrepareRawShadow` and `legacyPrepareShadowSource` gate on
`legacyWaitForHealthyServices` (1s poll of `docker inspect` health), but the container
cannot report healthy before the healthcheck's first 10s-interval probe. ~6.5s dead wait
per provision, including CI and cache-miss paths.

**Change:** for the **shadow container only** (do not touch the long-running `db`
container's wait), replace the docker-health gate with a readiness probe that polls, on the
same 1s constant backoff and the same `healthTimeoutSeconds` budget:

1. `legacyInspectContainerState` → still `running`? (preserves the crash-detection the
   health gate provided; a dead container fails fast with the same
   `LegacyHealthCheckTimeoutError` shape + log dump behavior); then
2. a short-timeout TCP/auth connect attempt (reuse `LegacyDbConnection.connect` the way
   `legacyConnectShadowDatabase` does, or `pg_isready` semantics via a cheap connect) —
   success ⇒ ready.

Suggested shape: a `legacyWaitForShadowReady(spawner, containerId, connConfig, opts)` in
`shared/db-bootstrap/health-check.ts` (or a sibling module), used by
`legacyPrepareRawShadow` (`shadow-database.ts`) and `legacyPrepareShadowSource`
(`commands/db/shared/legacy-shadow-source.ts`). Keep the container's healthcheck config
unchanged (other tooling reads it); only the CLI-side wait changes.

**Files:**

- `apps/cli/src/legacy/shared/db-bootstrap/health-check.ts` (new probe)
- `apps/cli/src/legacy/shared/db-bootstrap/shadow-database.ts` (`legacyPrepareRawShadow`)
- `apps/cli/src/legacy/commands/db/shared/legacy-shadow-source.ts`
- unit/integration tests colocated per repo convention

**Tests (RED first, per repo policy):** integration test with a mocked container-state /
connection layer proving the wait resolves as soon as a connect succeeds (does not wait
for docker health), still fails with the timeout error + log dump when the container never
becomes connectable, and fails fast when the container exits.

**Acceptance:** shadow provision reaches "connected" in roughly `postgres-ready + ≤1s`
(measured ~3.5–5s instead of ~10.5s); error behavior on a broken container unchanged in
shape.

## Workstream B — clean fast shadow shutdown (small, enables C)

**Problem:** `sh` as PID 1 swallows SIGTERM → every shadow stop (and workstream C's
cache-release stop) burns the 10s grace period and ends in SIGKILL.

**Change:** in the entrypoint script builders (`postgres.service.ts`,
`legacyPostgresEntrypointScriptPg15` / `…Pg14`), `exec` the final command: `… && exec
docker-entrypoint.sh postgres -D /etc/postgresql <args>`. Decide scope deliberately:

- Minimal/safe: apply only in `legacyBuildShadowPostgresContainerSpec`'s script (add a
  parameter to the script builders rather than post-processing the string).
- Broader (recommended if reviewers agree): apply to the long-running `db` container too —
  it has the same latent 10s-stop cost — but that touches the Go-parity container shape,
  so call it out explicitly in the PR rather than folding it in silently.

**Tests:** unit snapshot of the generated script (existing spec builders have snapshot
coverage patterns); a live test is optional (`stop` timing is observable but flaky to
assert — asserting the script contains `exec` is enough).

## Workstream C — warm shadow container cache

New module, suggested `apps/cli/src/legacy/shared/db-bootstrap/shadow-cache.ts`, exposing
an acquire/release pair that call sites use in place of bare
`legacyCreateShadowDatabase` / `legacyRemoveShadowDatabase`. Gate the whole feature behind
an opt-in env var (e.g. `SUPABASE_SHADOW_CACHE=1`) for the first release; flip the default
once proven.

### Cold provision (cache miss)

1. Create + start the shadow as today (no `autoRemove` when caching — the container must
   survive), **labeled** with the project labels plus a new
   `com.supabase.cli.shadow-cache-key=<hash>` label.
2. Run the existing baseline setup (`legacySetupShadowDatabase` /
   `legacyMigrateShadowDatabase` path unchanged up to the baseline; user migrations are
   _not_ part of the cached state — see reset protocol).
3. **Snapshot for reuse**, immediately after the baseline (before migrations/declarative
   load):
   - `CREATE DATABASE _supabase_shadow_base TEMPLATE postgres` (requires no other
     connections to `postgres` — sequence it before pg-delta connects);
   - capture cluster-global state: `pg_roles` (name + attribute columns), `pg_auth_members`
     (role, member, admin_option), and cluster-wide `pg_db_role_setting` rows
     (`setdatabase = 0`);
   - persist metadata JSON to `supabase/.temp/pgdelta/shadow-cache-<key>.json`:
     `{ key, containerId, createdAt, roleSnapshot, membershipSnapshot, roleSettings }`.
4. Proceed with the run as today (migrations applied to `postgres`, `contrib_regression`
   template creation, pg-delta, …).
5. **Release:** instead of `docker rm -f -v` → `docker stop` (fast after workstream B).
   Keep release best-effort exactly like `legacyRemoveShadowDatabase` (never mask the
   run's own outcome).

### Warm acquire (cache hit)

1. Compute the key; look up the metadata file **and** the container (`docker ps -a
--filter label=com.supabase.cli.shadow-cache-key=<hash>`). Either missing, or container
   already running (another concurrent run owns it) ⇒ miss (concurrent case: fall through
   to a one-off uncached cold shadow, do not remove the cached one).
2. `docker start` (~1s), wait via workstream A's probe.
3. **Reset to pristine:**
   - reverse the role delta vs. the snapshot: drop roles not in the snapshot (`DROP OWNED
BY` in each affected DB is unnecessary once `postgres` is recreated — drop role after
     the DB recreate below to avoid dependency errors; simplest safe order: recreate DBs
     first, then `DROP ROLE`), revoke added memberships, re-grant removed ones, delete
     cluster-wide `pg_db_role_setting` rows not in the snapshot;
   - connect to `_supabase_shadow_base` and `DROP DATABASE postgres WITH (FORCE)` +
     `CREATE DATABASE postgres TEMPLATE _supabase_shadow_base` — every downstream consumer
     keeps using `postgres` + `contrib_regression` unchanged;
   - `DROP DATABASE IF EXISTS contrib_regression WITH (FORCE)` (recreated by the normal
     flow).
4. Hand the same `LegacyShadowSourceResult` shape to the caller; the rest of the run is
   byte-identical to today.
5. Any step failing ⇒ escape hatch (rm + cold provision + fresh snapshot).

### Interactions & housekeeping

- **`supabase stop`** sweeps project-labeled containers — it will delete the cached shadow.
  That is acceptable (cache cleared, next run cold-provisions); mention it in the PR, do
  not special-case.
- **Metadata/container drift:** container exists but metadata file missing (or vice versa)
  ⇒ miss + remove the orphan. Add the metadata file to the same retention/cleanup pass the
  catalog cache uses if one exists; otherwise overwrite-on-write is enough (one file per
  key, old keys' containers removed on key mismatch — enumerate by label, keep only the
  current key's container).
- **Leak window:** unlike today's `--rm` shadow, a crashed CLI leaves a _stopped, labeled_
  container. That is the cache working as intended; `supabase stop` and the key-mismatch
  sweep both reclaim it.

### Call sites to convert

Whatever consumes the create/remove pair around `legacyPrepareShadowSource` /
`legacyPrepareRawShadow` today (as of writing: `db diff`'s handler, `db pull`'s handler,
and `legacy-pgdelta.cache.ts`'s `exportViaShadowCatalog`) — all via
`Effect.acquireUseRelease`, so the seam is narrow: acquire ⇒ `shadow-cache` acquire,
release ⇒ `shadow-cache` release. `migration squash` (if/when it lands on the native
shadow path) picks it up for free through the same primitives.

### Tests

- **Unit:** cache-key builder (field order, every input changes the hash, disabled service
  excludes its tag); reset-SQL builder (role delta → exact DROP/REVOKE/GRANT statements,
  snapshot round-trip).
- **Integration:** acquire/release state machine with mocked spawner + DB session layers —
  hit path, each miss reason (no container, no metadata, running container, key mismatch),
  and the escape hatch on reset failure (asserts rm + cold fallback ordering).
- **Live (`*.live.test.ts`, gated per repo policy, golden path only):** one scenario —
  cold acquire, release, warm acquire on the same key asserts the container id is reused
  and a role created between the two runs is gone after reset.

## Sequencing

1. **A** — readiness gate (`fix(cli)`, independently shippable, benefits every provision).
2. **B** — entrypoint `exec` (`fix(cli)` or folded into C's PR; required for C's fast
   release).
3. **C** — warm cache behind the env-var gate (`feat(cli)`), then a follow-up to default it
   on after bake time.

Each item follows the repo's RED→GREEN rule (failing test first, capture the failure in
the commit/PR). PR titles: conventional commits, `(cli)` scope. Per repo policy, no test
plans in PR descriptions.

## Non-goals

- No changes to `supabase/pg-toolbelt` / pg-delta. The isolated shadow contract
  (pre-provisioned, baseline rows tolerated, cluster DDL allowed) already accommodates a
  reused container.
- No changes to the co-located shadow path (pg-delta's `provisionCoLocatedShadow` is
  already sub-second).
- No change to the migrations-catalog cache or its `setupInputsToken` (its service-tag
  omission is noted above as a possible separate issue — surface to a human, don't fix
  here).
- No healthcheck-config changes on the container itself.

## Appendix — reproducing the benchmark

The numbers above came from a throwaway harness (not committed): generate the exact
entrypoint script by importing the `LEGACY_START_DB_*_SQL` template constants and
concatenating them the way `legacyPostgresEntrypointScriptPg15` does (with
`-c max_worker_processes=0`), `docker create` with the spec's env/healthcheck flags,
`docker cp` the pgsodium root key to `/etc/postgresql-custom/pgsodium_root.key`, start,
then poll (a) `pg_isready` via `docker exec`, (b) `docker inspect
'{{.State.Health.Status}}'`. Run the three one-shot jobs with the env built by
`legacyBuildRealtimeEnv` / `legacyStartStorageMigrateEnv` / `legacyStartAuthMigrateEnv`
against the shadow's 12-char container id as `DB_HOST` on the same network. Warm numbers:
`docker stop` + `docker start` the same container and re-poll.

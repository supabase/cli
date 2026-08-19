# pg-delta / shadow-database follow-ups

Deferred review findings that are valid but out of scope for the PR that surfaced them.
Each entry names the PR it came out of so the context is recoverable.

## ~~Shadow baseline cache key does not cover CLI-embedded init SQL~~ (resolved in PR #6184)

Resolved on the PR itself after depthfirst independently flagged it: the key now folds in a
digest of the embedded init/privilege SQL constants (`LEGACY_SHADOW_BASELINE_SQL_DIGEST`,
`shadow-cache.ts`). Original write-up kept below for the rationale and the alternative considered.

## Original: shadow baseline cache key does not cover CLI-embedded init SQL (PR #6184)

The cache key (`legacyShadowCacheKey`, `apps/cli/src/legacy/shared/db-bootstrap/shadow-cache.ts`)
hashes every *config-derived* input baked into the shadow cluster, but not the CLI-embedded init
SQL the entrypoint heredocs into the cluster at `initdb` time (`LEGACY_START_DB_SCHEMA_SQL`,
`LEGACY_START_DB_WEBHOOK_SQL`, `LEGACY_START_DB_SUPABASE_SQL` — `postgres.service.ts`), nor the
baseline steps `legacySetupDatabase` itself performs (API privileges SQL, vault upsert SQL). If a
CLI release changes any of those without a `supabase/postgres` image bump, a warm tar produced by
the older CLI silently restores the older baseline.

Realistic frequency is low (these constants track Go's `start.go` templates and change rarely,
usually alongside image bumps), which is why it did not block #6184. Two candidate fixes:

- Fold the CLI version into the key — over-invalidates once per release (~one 15s cold run per
  upgrade), trivially safe, one line.
- Hash the embedded SQL constants themselves — precise, no per-release invalidation, slightly more
  surface.

Either way, add a unit-test mutation case alongside the existing ones in
`shadow-cache.unit.test.ts`.

## ~~Make the baseline/declarative catalog shadows use `legacyWaitForShadowReady`~~ (resolved in PR #6184)

Resolved on the PR itself: both catalog provisioners now wait with `legacyWaitForShadowReady`
(`legacy-pgdelta.cache.ts`). Original write-up kept below.

## Original: make the baseline/declarative catalog shadows use `legacyWaitForShadowReady` (PR #6184 × CLI-1970 merge)

CLI-1970 (#6162) made `legacyExportBaselineCatalogRef`/`legacyExportDeclarativeCatalogRef`
(`legacy-pgdelta.cache.ts`) native. `legacySetupShadowDatabase` is now baseline-state-aware
(skip when `baselinePresent`; snapshot on a cache-enabled cold provision), and those catalog
provisions thread the acquire handle through, so a warm hit no longer double-applies the
baseline. They still wait with `legacyWaitForHealthyServices` (docker healthcheck, 10s interval)
instead of `legacyWaitForShadowReady` (container-state + short connect), so a warm restore can
sit until the first healthcheck tick.

The bundled pg-delta next sync/diff shadows (`legacy-pgdelta-next-shadow.layer.ts`) already use
the cache-aware acquire + `legacyWaitForShadowReady`.

## Shadow-cache robustness follow-ups from the #6184 review (Codex, deferred)

Five valid-but-deferred findings from the #6184 review rounds. None block the feature: each is an
edge on an already-degraded path (infra failures, races) where the cache's fail-open design keeps
the command correct, at worst at cold-provision speed.

- **Warm readiness failures always mark the tar suspect** (`shadow-cache.ts`,
  `legacyWarmShadow`): a Docker inspect/daemon hiccup during the restored container's readiness
  wait reaches the unconditional `tarSuspect: true` mapping, so a valid tar can be deleted on a
  pure infra blip (the cold fallback then re-exports it, so the cost is one cold run). Fix: only
  set `tarSuspect` when the container stayed inspectable/running and Postgres itself failed
  readiness. (Codex comment 3786040107.)
- **Snapshot-revive failures all report `reason: "docker_daemon"`** (`shadow-cache.ts`,
  `legacyExportShadowBaseline`): the post-snapshot `docker start` and the follow-up readiness
  wait share one error mapping, so a Postgres-side failure after a successful start is
  fingerprinted as a daemon outage in telemetry. Fix: map the two stages separately.
  (Codex comment 3786040112.)
- **A failed warm restore can leak the created container** (`container-lifecycle.ts` +
  `shadow-cache.ts`): `legacyCreateContainer`'s post-create cleanup covers a failed archive
  extraction, but a failure in the secret-file copy or the final `docker start` leaves the
  created container behind while the warm→cold fallback retries with a replacement. At most one
  stopped project-labeled container; `supabase stop` sweeps it. Fix: extend the tapError cleanup
  to every post-create step. (Codex comment 3789148842.)
- **Cache-key JWKS resolution runs before the `Initialising schema...` banner**
  (`shadow-cache.ts`, `legacyResolveShadowCacheKeyInputs`): a third-party JWKS discovery failure
  on a cache-eligible acquire surfaces before the banner that the uncached flow prints first
  (CLI-1956 shape). Fix: defer the key's JWKS resolution until after the prelude has printed,
  reusing the resolved value for setup. (Codex comment 3789363067.)
- **`roles.sql` TOCTOU between key hash and execution** (`shadow-cache.ts` +
  `db-setup.ts`): the key hashes `roles.sql` once, and `legacySetupDatabase` re-reads the path
  later; an edit in that window publishes a tar under a key describing the old contents. Fix:
  thread the captured contents into setup, or re-hash before publishing. (Codex comment
  3789363070.)
- **Warm restores keep the cold container's id as Realtime's seeded `DB_HOST`**
  (`shadow-database.ts` + `realtime-env.ts`): the cold one-shot Realtime job seeds
  `_realtime.extensions` with the exporting container's 12-char id, and a warm restore (different
  container, job skipped) leaves that dead id in the encrypted settings. Only migrations that
  inspect or act on Realtime tenant configuration can observe the difference. Fix: normalize the
  seeded host before snapshotting, or refresh it after restore. (Codex comment 3789481478.)
- **Cache key hashes image tags, not immutable digests** (`shadow-cache.ts`,
  `legacyShadowCacheKey`): a registry tag republished with different bytes (or a locally retagged
  image) keeps the same key, so a warm hit would restore the previous image's baseline and skip
  the updated service migrations. Accepted risk: every keyed image is an exact pinned version tag
  the release pipeline treats as immutable, a changed `SUPABASE_INTERNAL_IMAGE_REGISTRY` is
  already in the key, and the 14-day TTL bounds staleness. Hashing digests is structurally
  costly — the key is computed before images are pulled, so `docker image inspect` would have to
  either move pulls ahead of the cache decision or fall back to tags for unpulled images (making
  the first published tar never warm-hit), and it adds per-acquire inspect round-trips to the
  warm path. Revisit only if the image-resolution pipeline ever produces mutable tags (`latest`,
  branch tags) — those should become cache-ineligible at that point. (Codex comment 3802804637.)

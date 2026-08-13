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

## Make the baseline/declarative catalog shadows warm-aware (PR #6184 × CLI-1970 merge)

CLI-1970 (#6162) made `legacyExportBaselineCatalogRef`/`legacyExportDeclarativeCatalogRef`
(`legacy-pgdelta.cache.ts`) native, so `db schema declarative sync`/`generate` now provision a
second shadow in-process for the declarative/baseline catalog. Those callers pass an unconditional
`{ bypassCache: true }` to `exportViaShadowCatalog`: their provisions run the platform baseline via
`legacySetupShadowDatabase`, which is not baseline-state-aware, so a warm PGDATA hit would
double-apply the baseline.

The snapshot seam is a natural fit — the tar IS exactly the post-baseline state these provisions
build (baseline only, no migrations), so a warm hit would need NO further setup at all, saving the
full ~15s per declarative-catalog miss. Requires threading `LegacyShadowBaselineState` through
`legacySetupShadowDatabase` (skip when `baselinePresent`) and swapping their
`legacyWaitForHealthyServices` docker-health wait for `legacyWaitForShadowReady`.

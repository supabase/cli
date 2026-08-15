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

## Make the baseline/declarative catalog shadows use `legacyWaitForShadowReady` (PR #6184 × CLI-1970 merge)

CLI-1970 (#6162) made `legacyExportBaselineCatalogRef`/`legacyExportDeclarativeCatalogRef`
(`legacy-pgdelta.cache.ts`) native. `legacySetupShadowDatabase` is now baseline-state-aware
(skip when `baselinePresent`; snapshot on a cache-enabled cold provision), and those catalog
provisions thread the acquire handle through, so a warm hit no longer double-applies the
baseline. They still wait with `legacyWaitForHealthyServices` (docker healthcheck, 10s interval)
instead of `legacyWaitForShadowReady` (container-state + short connect), so a warm restore can
sit until the first healthcheck tick.

The bundled pg-delta next sync/diff shadows (`legacy-pgdelta-next-shadow.layer.ts`) already use
the cache-aware acquire + `legacyWaitForShadowReady`.

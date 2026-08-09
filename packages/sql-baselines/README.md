# @supabase/sql-baselines

Static, versioned SQL bundles for service schemas — the prototype for the
[sql-baselines RFC](https://linear.app/supabase/document/vision-rfc-sql-baselines-static-versioned-sql-bundles-for-service-5fcd634ed89b).

Reaching "parity with a running stack" today requires booting the realtime,
storage and auth services so each can run its own migration framework against
the database. The CLI does this with three sequential one-shot Docker jobs on
every `db start`, `db reset`, and every shadow-database provisioning. This
package extracts the exact SQL those migrations produce into static artifacts
so any consumer can reach post-service-setup state with plain `psql` replays —
no BEAM, no Node, no Go runtime, no Docker jobs.

## Artifact model

```
bundles/
  manifest.json                    # canonical apply order + known lineages
  pg17/
    realtime/v2.124.2/
      001_*.sql ...                # pg-delta plan output, one file per execution unit
      data.sql                     # TRUNCATE + byte-exact rows of migration bookkeeping tables
      manifest.json                # ordered apply list + determinism tuple + provenance
    storage/v1.68.10/...
    auth/v2.195.0/...
```

A bundle is an **ordered list of SQL files** declared in its `manifest.json`,
applied as `supabase_admin` with a statement-splitting runner (ownership and
grants are explicit in the plan output, so the original service role is
provenance, not an execution parameter). Bundles are **full** ("empty service
state → vX") and **sequential**: each is the diff of cluster state N−1 → N in
the canonical order realtime → storage → auth, because services read cluster
state left by their predecessors.

`data.sql` is non-negotiable and byte-exact: the correctness bar is that the
real service boots against a bundled database and no-ops (`storage.migrations`
sha1 hashes are validated on every boot; auth and realtime check their
`schema_migrations` rows).

## Consuming

```ts
import { loadBundleStore, planReplay } from "@supabase/sql-baselines";

const store = await Effect.runPromise(loadBundleStore("bundles"));
const steps = planReplay(store.index, "pg17", {
  realtime: "v2.124.2",
  storage: "v1.68.10",
  auth: "v2.195.0",
});
// Each step is a Hit (ordered SQL files to replay) or a Miss (fall back to
// that service's container migrate job). A miss on an earlier service
// degrades later steps, because bundles are sequential diffs.
```

A miss is not an error: hosted projects can pin service versions that were
never bundled. Bundles are an optimization with a permanent fallback, not a
hard cutover.

## Generating

Requires Docker and network access to pull the pinned images. Pins are read
from the CLI's own image source of truth
(`apps/cli-go/pkg/config/templates/Dockerfile`).

```sh
pnpm generate                     # pg17, with zero-diff replay verification
bun run ./scripts/generate.ts --lineage pg15
bun run ./scripts/generate.ts --skip-verify --keep   # debugging
```

The generator:

1. starts the pinned `supabase/postgres` exactly as `db start` does (same
   entrypoint, same CLI templates: role passwords, `_realtime` schema,
   webhooks, `_supabase` database);
2. per service, snapshots the catalog with pg-delta, runs the service's
   one-shot migrate job with the CLI's env verbatim
   (`src/generator/jobs.ts` mirrors `initSchema15`), drops objects that
   cannot be static (realtime's dated `messages_*` partitions — recorded in
   the manifest), snapshots again, and persists the plan + bookkeeping rows;
3. verifies by replaying all bundles into a fresh container and requiring a
   zero catalog diff against sequential service execution plus byte-exact
   tracking tables.

## Determinism tuple

"Schema after migrations" is not a function of (service version, pg major)
alone. v1 pins one canonical tuple — the CLI local-dev configuration
(single-tenant storage, `DB_INSTALL_ROLES=false`, no orioledb, fixed
local-dev keys) — and records the migrate-job env verbatim in each bundle
manifest. Consumers outside the tuple fall back to container jobs.

## Known prototype limitations

- `_realtime` tenant seed rows are captured in `data.sql` with the fixed
  local-dev `DB_ENC_KEY`. Their encrypted columns are not byte-reproducible
  across generation runs (fresh IVs), so regenerating diffs `data.sql` even
  when nothing changed. RFC open question 1 (bundle vs CLI template) is
  unresolved here.
- The service no-op-boot verification (RFC verification 7b) is not implemented
  yet; only the zero-diff replay (7a) is.
- No release-triggered automation yet: `pnpm generate` is manual.
- Backfill of historical service versions and the orioledb lineage are out of
  scope.

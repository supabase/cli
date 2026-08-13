/**
 * The one on-disk location every pg-delta-adjacent cache/snapshot artefact lives under.
 *
 * Split out of `legacy-pgdelta.cache.ts` (which owns the catalog cache's keys AND its
 * shadow-provisioning resolution path) so `db-bootstrap/shadow-cache.ts` — the warm
 * shadow-container cache, which `legacy-pgdelta.cache.ts` itself consumes for its own
 * shadow provisioning — can reach the same directory without an import cycle between
 * the two.
 */

import type { Path } from "effect";

/** `supabase/.temp/pgdelta` — where catalog snapshots, debug bundles, and the shadow-container cache's metadata live (`declarative.go:44`). */
export function legacyPgDeltaTempPath(path: Path.Path, workdir: string): string {
  return path.join(workdir, "supabase", ".temp", "pgdelta");
}

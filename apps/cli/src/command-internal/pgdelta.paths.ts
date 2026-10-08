/**
 * On-disk locations for pg-delta-adjacent cache/snapshot artefacts.
 *
 * Two roots:
 * - {@link pgDeltaTempPath}: project-local (`supabase/.temp/pgdelta`) — catalog
 *   snapshots and debug bundles (Go-shared, workspace-mounted).
 * - {@link shadowBaselineCacheDir}: global under `SUPABASE_HOME` — the shadow
 *   baseline PGDATA tars, shared across worktrees with the same settings.
 */

import { homedir } from "node:os";

import { Effect, type Path } from "effect";

import { readSupabaseHome } from "../shared/config/supabase-home.ts";

/** `supabase/.temp/pgdelta` — catalog snapshots and debug bundles. */
export function pgDeltaTempPath(path: Path.Path, workdir: string): string {
  return path.join(workdir, "supabase", ".temp", "pgdelta");
}

/**
 * Global shadow-baseline cache directory:
 * `${SUPABASE_HOME}/cache/shadow-baseline` (default `~/.supabase/cache/shadow-baseline`).
 */
export const shadowBaselineCacheDir = (path: Path.Path, homeDir: string = homedir()) =>
  Effect.map(readSupabaseHome(path, homeDir), (home) =>
    path.join(home, "cache", "shadow-baseline"),
  );

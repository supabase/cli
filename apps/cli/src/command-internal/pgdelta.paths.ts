/**
 * On-disk locations for pg-delta-adjacent cache/snapshot artefacts.
 *
 * Two roots:
 * - `pgdeltaScratchDir`: `supabase/.temp/pgdelta` in legacy state (workspace-mounted),
 *   `$SUPABASE_HOME/tmp/pgdelta/<project hash>` in stack state — catalog snapshots and debug bundles.
 * - {@link shadowBaselineCacheDir}: global under `SUPABASE_HOME` — the shadow
 *   baseline PGDATA tars, shared across worktrees with the same settings.
 */

import { homedir } from "node:os";

import { Effect, type Path } from "effect";

import { readSupabaseHome } from "../shared/config/supabase-home.ts";

/**
 * Global shadow-baseline cache directory:
 * `${SUPABASE_HOME}/cache/shadow-baseline` (default `~/.supabase/cache/shadow-baseline`).
 */
export const shadowBaselineCacheDir = (path: Path.Path, homeDir: string = homedir()) =>
  Effect.map(readSupabaseHome(path, homeDir), (home) =>
    path.join(home, "cache", "shadow-baseline"),
  );

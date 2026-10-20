/**
 * On-disk locations for pg-delta-adjacent cache/snapshot artefacts.
 *
 * Two roots:
 * - `pgdeltaScratchDir`: `supabase/.temp/pgdelta` in legacy state (Go-shared, workspace-mounted),
 *   `$SUPABASE_HOME/tmp/pgdelta/<project hash>` in stack state — catalog snapshots and debug bundles.
 * - {@link shadowBaselineCacheDir}: global under `SUPABASE_HOME` — the shadow
 *   baseline PGDATA tars, shared across worktrees with the same settings.
 */

import { homedir } from "node:os";

import type { Path } from "effect";

import { resolveSupabaseHome } from "../shared/config/supabase-home.ts";

/**
 * Global shadow-baseline cache directory:
 * `${SUPABASE_HOME}/cache/shadow-baseline` (default `~/.supabase/cache/shadow-baseline`).
 *
 * Pure: callers may pass `env`/`homeDir` for tests; production uses `process.env` and
 * `os.homedir()`.
 */
export function shadowBaselineCacheDir(
  path: Path.Path,
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): string {
  return path.join(resolveSupabaseHome(path, env, homeDir), "cache", "shadow-baseline");
}

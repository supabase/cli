/**
 * On-disk locations for pg-delta-adjacent cache/snapshot artefacts.
 *
 * Two roots:
 * - {@link legacyPgDeltaTempPath}: project-local (`supabase/.temp/pgdelta`) — catalog
 *   snapshots and debug bundles (Go-shared, workspace-mounted).
 * - {@link legacyShadowBaselineCacheDir}: global under `SUPABASE_HOME` — the shadow
 *   baseline PGDATA tars, shared across worktrees with the same settings.
 */

import { homedir } from "node:os";

import type { Path } from "effect";

import { resolveSupabaseHome } from "../../shared/config/supabase-home.ts";

/** `supabase/.temp/pgdelta` — catalog snapshots and debug bundles (`declarative.go:44`). */
export function legacyPgDeltaTempPath(path: Path.Path, workdir: string): string {
  return path.join(workdir, "supabase", ".temp", "pgdelta");
}

/**
 * Global shadow-baseline cache directory:
 * `${SUPABASE_HOME}/cache/shadow-baseline` (default `~/.supabase/cache/shadow-baseline`).
 *
 * Pure: callers may pass `env`/`homeDir` for tests; production uses `process.env` and
 * `os.homedir()`.
 */
export function legacyShadowBaselineCacheDir(
  path: Path.Path,
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): string {
  return path.join(resolveSupabaseHome(env, homeDir), "cache", "shadow-baseline");
}

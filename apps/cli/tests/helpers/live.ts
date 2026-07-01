import { describe } from "vitest";

import { runSupabase } from "./cli.ts";
import {
  isLiveConfigured,
  LIVE_DEFAULT_PROFILE,
  LIVE_EXIT_TIMEOUT_MS,
  liveProjectDataPlaneReady,
  liveProjectRef,
} from "./live-env.ts";

/**
 * Test-facing helpers for the `live` Vitest project (`*.live.test.ts`):
 * black-box CLI subprocess tests that run against a *real* Supabase platform —
 * in CI a local supabox stack (see the `supabase/cli-e2e-ci` harness).
 *
 * This module imports Vitest test APIs (`describe`), so it must NOT be imported
 * from `globalSetup` (Vitest evaluates that in a different context). The
 * env-only helpers live in `./live-env.ts`; `globalSetup` imports from there.
 * They are re-exported below so test files have a single import site.
 */

// Re-export the env-only helpers so `*.live.test.ts` files import everything
// from `helpers/live.ts`.
export {
  isLiveConfigured,
  LIVE_DEFAULT_PROFILE,
  LIVE_EXIT_TIMEOUT_MS,
  liveApiBaseUrl,
  liveProjectDataPlaneReady,
  liveProjectRef,
  requireLiveProjectRef,
} from "./live-env.ts";

/**
 * `describe` that runs only when the live environment is configured. Use this
 * for every live suite so the file is inert (skipped, not failed) outside the
 * cli-e2e-ci runner.
 */
export const describeLive = describe.skipIf(!isLiveConfigured());

/**
 * `describe` for project-scoped live suites: runs only when the live env is
 * configured AND a project ref is available. On a control-plane-only stack
 * (e.g. local macOS where project instances can't be built) these skip rather
 * than fail. See `requireLiveProjectRef`.
 */
export const describeLiveProject = describe.skipIf(!isLiveConfigured() || !liveProjectRef());

/**
 * `describe` for data-plane live suites (migration / db / storage): runs only
 * when the live env is configured AND the project's own Postgres instance is
 * `ACTIVE_HEALTHY`. On a control-plane-only stack — including the current
 * cli-e2e-ci CI, which omits `supabase-postgres-17` (CLI-1825) — the project DB
 * is unreachable, so these SKIP rather than fail. They activate automatically
 * once the full data-plane is provisioned. The readiness probe runs once at
 * collection time (top-level await); see `liveProjectDataPlaneReady`.
 */
export const describeLiveDataPlane = describe.skipIf(!(await liveProjectDataPlaneReady()));

/**
 * Spawn the built CLI against the live platform, injecting the profile so the
 * Management API base resolves to the stack. Defaults to the `legacy` shell,
 * which hosts the platform commands (orgs, projects, branches, functions, …).
 */
export function runSupabaseLive(
  args: string[],
  options?: Parameters<typeof runSupabase>[1],
): ReturnType<typeof runSupabase> {
  return runSupabase(args, {
    entrypoint: "legacy",
    ...options,
    exitTimeoutMs: options?.exitTimeoutMs ?? LIVE_EXIT_TIMEOUT_MS,
    env: {
      SUPABASE_PROFILE: process.env["SUPABASE_PROFILE"] ?? LIVE_DEFAULT_PROFILE,
      ...options?.env,
    },
  });
}

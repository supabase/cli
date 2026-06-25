import { describe } from "vitest";

import { runSupabase } from "./cli.ts";
import {
  isLiveConfigured,
  LIVE_DEFAULT_PROFILE,
  LIVE_EXIT_TIMEOUT_MS,
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

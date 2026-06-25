import { describe } from "vitest";
import { runSupabase } from "./cli.ts";

/**
 * Helpers for the `live` Vitest project (`*.live.test.ts`): black-box CLI
 * subprocess tests that run against a *real* Supabase platform — in CI that is
 * a local supabox stack (see the `supabase/cli-e2e-ci` harness).
 *
 * Unlike `*.e2e.test.ts`, which use fake tokens and assert error/golden-path
 * surface behavior, live tests exercise real Management API, edge function,
 * database, and storage flows end to end. They are gated off by default and
 * only run when a live access token is present in the environment, so the
 * normal unit/integration/e2e loop never touches a network.
 *
 * Environment contract (provided by the cli-e2e-ci runner):
 * - `SUPABASE_ACCESS_TOKEN` — required; the platform PAT (supabox seeds a
 *   deterministic `sbp_…` token into its mgmt-api database).
 * - `SUPABASE_PROFILE` — selects the API base URL; defaults to `supabase-local`
 *   (→ `http://localhost:8080`, `project_host: supabase.red`). Note the cli does
 *   NOT honor `SUPABASE_API_URL` (Go parity) — the profile is the override.
 * - `SUPABASE_LIVE_API_URL` — base URL the readiness check probes; defaults to
 *   `http://localhost:8080`.
 * - `NODE_EXTRA_CA_CERTS` — trusts the supabox CA for `*.supabase.red` TLS;
 *   inherited by the subprocess via the parent environment.
 */

/** Default profile for the host runner: api_url → localhost:8080, project_host → supabase.red. */
export const LIVE_DEFAULT_PROFILE = "supabase-local";

/**
 * Default subprocess exit timeout for live runs. `runSupabase` otherwise caps at
 * 60s, which would kill a slow-but-valid supabox call before the live tests'
 * own (60–120s+) timeouts fire. Generous, but under the `live` project's 300s
 * cap so the per-test timeout stays the real gate. Callers may override.
 */
export const LIVE_EXIT_TIMEOUT_MS = 240_000;

/** Management API base URL probed by the live readiness check. */
export function liveApiBaseUrl(): string {
  return process.env["SUPABASE_LIVE_API_URL"] ?? "http://localhost:8080";
}

/**
 * True when the environment carries a platform access token, i.e. the live
 * suite is expected to run. Used to gate `describeLive` so live tests are inert
 * in the default test loop.
 */
export function isLiveConfigured(): boolean {
  return Boolean(process.env["SUPABASE_ACCESS_TOKEN"]);
}

/**
 * `describe` that runs only when the live environment is configured. Use this
 * for every live suite so the file is inert (skipped, not failed) outside the
 * cli-e2e-ci runner.
 */
export const describeLive = describe.skipIf(!isLiveConfigured());

/**
 * Project ref for project-scoped live scenarios (functions, branches, db,
 * storage, …). The cli-e2e-ci runner sets this once a project has been
 * provisioned on the stack; absent → those suites skip. Returns `undefined`
 * when unset so callers can branch; use `requireLiveProjectRef` inside a
 * `describeLiveProject` block where presence is already guaranteed.
 */
export function liveProjectRef(): string | undefined {
  return process.env["SUPABASE_LIVE_PROJECT_REF"];
}

/**
 * The live project ref, or a thrown error if unset. Safe to call inside a
 * `describeLiveProject` block (the gate guarantees it is present) and gives a
 * typed `string` without a non-null assertion.
 */
export function requireLiveProjectRef(): string {
  const ref = liveProjectRef();
  if (!ref) {
    throw new Error(
      "SUPABASE_LIVE_PROJECT_REF must be set for project-scoped live tests " +
        "(the cli-e2e-ci runner sets it after provisioning a project).",
    );
  }
  return ref;
}

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

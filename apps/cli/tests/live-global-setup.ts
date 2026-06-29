// Import from the Vitest-free env module — globalSetup runs in a context where
// importing Vitest test APIs (which `helpers/live.ts` pulls in) is not valid.
import { isLiveConfigured, liveApiBaseUrl } from "./helpers/live-env.ts";

/**
 * Global setup for the `live` Vitest project. When the live environment is not
 * configured the suite is skipped (via `describeLive`) and this is a no-op.
 *
 * When it IS configured (the cli-e2e-ci runner sets `SUPABASE_ACCESS_TOKEN`),
 * fail fast with a clear message if the platform is unreachable, so a
 * misconfigured stack surfaces as a setup error rather than dozens of opaque
 * per-test timeouts.
 */
export async function setup(): Promise<void> {
  if (!isLiveConfigured()) {
    return;
  }

  // Reachability gate only. Any HTTP response — including 401/404 — proves the
  // Management API is up and routing, which is all this probe needs to assert.
  // supabox's mgmt-api requires auth on every route and exposes no public health
  // endpoint (`/v1/health` 404s; an unauthenticated request is rejected by the
  // auth middleware with 401), so we deliberately do NOT require a 2xx here.
  // Functional and auth coverage is the live tests' job (e.g. `orgs list`).
  const probeUrl = `${liveApiBaseUrl()}/v1/organizations`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    await fetch(probeUrl, { signal: controller.signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Live platform is not reachable at ${probeUrl}: ${reason}.\n` +
        "Ensure the supabox stack is up and the host can reach mgmt-api (see cli-e2e-ci).",
    );
  } finally {
    clearTimeout(timeout);
  }
}

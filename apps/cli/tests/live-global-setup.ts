import { isLiveConfigured, liveApiBaseUrl } from "./helpers/live.ts";

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

  const healthUrl = `${liveApiBaseUrl()}/v1/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${healthUrl} responded with ${response.status}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Live platform is not reachable at ${healthUrl}: ${reason}.\n` +
        "Ensure the supabox stack is up and the host can reach mgmt-api (see cli-e2e-ci).",
    );
  } finally {
    clearTimeout(timeout);
  }
}

import { Effect } from "effect";
import { PostHog, type PostHogOptions } from "posthog-node";

const SHUTDOWN_TIMEOUT_MS = 5_000;

const droppedDelivery = {
  status: 200,
  text: () => Promise.resolve(""),
  json: () => Promise.resolve({}),
};

// posthog-node has no logger hook: delivery failures reach the user's
// terminal through hardcoded console.error calls inside the SDK, and failed
// batches are retried with multi-second delays that stall process shutdown.
// Reporting every attempt as delivered keeps telemetry fire-and-forget — a
// blocked or offline network must never surface errors or delays for a
// command that succeeded.
export function fireAndForgetFetch(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): NonNullable<PostHogOptions["fetch"]> {
  return async (url, options) => {
    try {
      const response = await fetchImpl(url, options);
      return response.status >= 400 ? droppedDelivery : response;
    } catch {
      return droppedDelivery;
    }
  };
}

export function scopedPosthogClient(apiKey: string, host: string) {
  return Effect.acquireRelease(
    Effect.sync(
      () =>
        new PostHog(apiKey, {
          host,
          flushAt: 1,
          flushInterval: 0,
          fetch: fireAndForgetFetch(),
        }),
    ),
    (client) => Effect.promise(() => client._shutdown(SHUTDOWN_TIMEOUT_MS)).pipe(Effect.ignore),
  );
}

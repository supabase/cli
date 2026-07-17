import { Effect } from "effect";
import { PostHog, type PostHogOptions } from "posthog-node";

const delivered = {
  status: 200,
  text: () => Promise.resolve(""),
  json: () => Promise.resolve({}),
};

// posthog-node prints delivery failures through hardcoded console.error calls
// (no logger hook) and retries them with multi-second delays; reporting every
// attempt as delivered keeps failures silent and off the critical path. The
// 2s requestTimeout bounds how long a blackholed connection can hold process
// exit, since shutdown awaits in-flight sends.
export const fireAndForgetFetch: NonNullable<PostHogOptions["fetch"]> = async (url, options) => {
  try {
    const response = await globalThis.fetch(url, options);
    return response.status >= 400 ? delivered : response;
  } catch {
    return delivered;
  }
};

export const scopedPosthogClient = (apiKey: string, host: string) =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new PostHog(apiKey, {
          host,
          flushAt: 1,
          flushInterval: 0,
          requestTimeout: 2_000,
          fetch: fireAndForgetFetch,
        }),
    ),
    // The rejection must be caught on the promise itself: Effect.promise turns
    // a rejection into a defect, which Effect.ignore does not swallow, so a
    // shutdown timeout would fail the whole command (exit 1 with an
    // UnknownError, observed on v2.109.1 whenever PostHog was unreachable).
    (client) => Effect.promise(() => client._shutdown(5_000).catch(() => undefined)),
  );

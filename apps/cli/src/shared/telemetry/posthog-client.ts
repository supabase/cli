import { Effect } from "effect";
import { PostHog, type PostHogOptions } from "posthog-node";

const delivered = {
  status: 200,
  text: () => Promise.resolve(""),
  json: () => Promise.resolve({}),
};

// posthog-node has no logger hook: delivery failures hit hardcoded
// console.error calls and multi-second retries, so report them as delivered.
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
    // Catch on the promise: Effect.promise turns rejections into defects,
    // which escape Effect.ignore and fail the command.
    (client) => Effect.promise(() => client._shutdown(5_000).catch(() => undefined)),
  );

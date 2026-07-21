import { Effect } from "effect";
import { PostHog, type PostHogOptions } from "posthog-node";

const EXIT_DELAY_CAP_MS = 2_000;

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
    Effect.sync(() => {
      const shutdown = new AbortController();
      const client = new PostHog(apiKey, {
        host,
        flushAt: 1,
        flushInterval: 0,
        requestTimeout: EXIT_DELAY_CAP_MS,
        fetch: (url, options) =>
          fireAndForgetFetch(url, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, shutdown.signal])
              : shutdown.signal,
          }),
      });
      return { client, shutdown };
    }),
    ({ client, shutdown }) =>
      Effect.promise(async () => {
        try {
          await client._shutdown(EXIT_DELAY_CAP_MS);
        } catch {
          // The deadline rejection must be swallowed: Effect.promise turns
          // rejections into defects, which would fail the command.
        } finally {
          // The shutdown deadline only stops the wait; the SDK's drain keeps
          // in-flight requests running and starts queued ones after release.
          // Aborting cancels them so nothing outlives the scope.
          shutdown.abort();
        }
      }),
  ).pipe(Effect.map(({ client }) => client));

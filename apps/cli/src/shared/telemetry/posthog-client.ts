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
      Effect.promise(() => client.shutdown(30_000).catch(() => undefined)).pipe(
        // Our Effect deadline precedes the SDK's noisy 30-second deadline.
        Effect.timeoutOption(EXIT_DELAY_CAP_MS),
        Effect.asVoid,
        // The SDK drain can continue after the Effect deadline; aborting its
        // fetches lets that background drain settle without active requests.
        Effect.ensuring(Effect.sync(() => shutdown.abort())),
      ),
  ).pipe(Effect.map(({ client }) => client));

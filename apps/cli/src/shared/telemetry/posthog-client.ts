import { Data, Effect } from "effect";
import type * as Scope from "effect/Scope";
import { PostHog, type PostHogOptions } from "posthog-node";
import {
  actionability,
  ErrorActionabilityId,
  type CliErrorActionabilityDeclaration,
} from "./error-actionability.ts";

const EXIT_DELAY_CAP_MS = 2_000;

const delivered = {
  status: 200,
  text: () => Promise.resolve(""),
  json: () => Promise.resolve({}),
};

class PosthogFetchError extends Data.TaggedError("PosthogFetchError")<{
  readonly cause: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

type FetchImplementation = (url: string | URL, options: RequestInit) => Promise<Response>;

// posthog-node has no logger hook: delivery failures hit hardcoded
// console.error calls and multi-second retries, so report them as delivered.
export const makeFireAndForgetFetch =
  (fetch: FetchImplementation): NonNullable<PostHogOptions["fetch"]> =>
  (url, options) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () => fetch(url, options),
          catch: (cause) => new PosthogFetchError({ cause }),
        }).pipe(Effect.orElseSucceed(() => delivered));
        if (response === delivered || response.status >= 400) {
          return delivered;
        }
        return response;
      }),
    );

export const scopedPosthogClient: (
  apiKey: string,
  host: string,
  fetch?: FetchImplementation,
) => Effect.Effect<PostHog, never, Scope.Scope> = (
  apiKey: string,
  host: string,
  // The PostHog SDK owns this outer Promise-based platform boundary; callers may
  // still inject a fetch implementation for deterministic tests.
  // oxlint-disable-next-line effecttsgo/global-fetch -- native fetch is the explicit host boundary for telemetry delivery.
  fetch: FetchImplementation = globalThis.fetch,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const shutdown = new AbortController();
      const client = new PostHog(apiKey, {
        host,
        flushAt: 1,
        flushInterval: 0,
        requestTimeout: EXIT_DELAY_CAP_MS,
        fetch: (url, options) =>
          makeFireAndForgetFetch(fetch)(url, {
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

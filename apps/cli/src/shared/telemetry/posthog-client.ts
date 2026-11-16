import { type Context, Effect, Exit, Option, Stream } from "effect";
import { constTrue } from "effect/Function";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { PostHog, type PostHogOptions } from "posthog-node";

const EXIT_DELAY_CAP_MS = 2_000;

type PostHogFetch = NonNullable<PostHogOptions["fetch"]>;
type PostHogFetchOptions = Parameters<PostHogFetch>[1];
type PostHogFetchResponse = Awaited<ReturnType<PostHogFetch>>;

const delivered: PostHogFetchResponse = {
  status: 200,
  text: () => Promise.resolve(""),
  json: () => Promise.resolve({}),
};

function toPostHogResponse(
  response: HttpClientResponse.HttpClientResponse,
  context: Context.Context<never>,
  signal: AbortSignal | undefined,
): PostHogFetchResponse {
  const body = () =>
    Stream.toReadableStreamWith(
      response.stream.pipe(
        Stream.catchReason("HttpClientError", "EmptyBodyError", () => Stream.empty),
      ),
      context,
    ).pipeThrough(new TransformStream(), { signal });
  return {
    status: response.status,
    headers: { get: (name) => Option.getOrNull(Headers.get(response.headers, name)) },
    text: () => new Response(body()).text(),
    json: () => new Response(body()).json(),
    get body() {
      return body();
    },
  };
}

const sendPosthogRequest = Effect.fnUntraced(function* (url: string, options: PostHogFetchOptions) {
  const client = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<never>();
  const request = HttpClientRequest.make(options.method)(url).pipe(
    HttpClientRequest.setBody(
      options.body === undefined ? HttpBody.empty : HttpBody.raw(options.body),
    ),
    HttpClientRequest.setHeaders(options.headers),
  );
  const response = yield* client
    .execute(request)
    .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, constTrue));
  return response.status >= 400 ? delivered : toPostHogResponse(response, context, options.signal);
});

// posthog-node has no logger hook: delivery failures hit hardcoded
// console.error calls and multi-second retries, so report them as delivered.
export function makePosthogFetch(context: Context.Context<HttpClient.HttpClient>): PostHogFetch {
  const runExit = Effect.runPromiseExitWith(context);
  return (url, options) =>
    options.signal?.aborted
      ? Promise.resolve(delivered)
      : runExit(sendPosthogRequest(url, options), { signal: options.signal }).then(
          Exit.match({ onSuccess: (response) => response, onFailure: () => delivered }),
        );
}

export const scopedPosthogClient = Effect.fnUntraced(function* (apiKey: string, host: string) {
  const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
  const { client } = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const shutdown = new AbortController();
      const client = new PostHog(apiKey, {
        host,
        flushAt: 1,
        flushInterval: 0,
        requestTimeout: EXIT_DELAY_CAP_MS,
        fetch: (url, options) =>
          posthogFetch(url, {
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
        Effect.withSpan("Analytics.flush"),
      ),
  );
  return client;
});

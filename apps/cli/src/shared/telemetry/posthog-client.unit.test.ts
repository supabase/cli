import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { PostHog } from "posthog-node";
import { makePosthogFetch, scopedPosthogClient } from "./posthog-client.ts";

const BATCH_URL = "https://eu.i.posthog.com/batch/";
const BATCH_OPTIONS = {
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

const respondingClient = (
  response: () => Response,
  requests: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return HttpClientResponse.fromWeb(request, response());
      }),
    ),
  );

describe("makePosthogFetch", () => {
  it.live("sends the SDK request as given and passes successful responses through", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const response = yield* Effect.promise(() => posthogFetch(BATCH_URL, BATCH_OPTIONS));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe(`{"status":1}`);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(BATCH_URL);
      expect(requests[0]?.headers).toEqual({ "content-type": "application/json" });
      expect(requests[0]?.body).toEqual(HttpBody.raw(BATCH_OPTIONS.body));
    }).pipe(
      Effect.provide(
        respondingClient(() => new Response(`{"status":1}`, { status: 200 }), requests),
      ),
    );
  });

  it.live("sends nothing when the signal is already aborted", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const response = yield* Effect.promise(() =>
        posthogFetch(BATCH_URL, { ...BATCH_OPTIONS, signal: AbortSignal.abort() }),
      );

      expect(response.status).toBe(200);
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(respondingClient(() => new Response("{}"), requests)));
  });

  it.live("rejects stalled body reads with the abort reason and releases their transport", () => {
    const transportAborts: Array<Deferred.Deferred<void>> = [];
    return Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const { signal, reads } = yield* Effect.scoped(
        Effect.gen(function* () {
          const signal = yield* Effect.abortSignal;
          const send = () =>
            Effect.promise(() => posthogFetch(BATCH_URL, { ...BATCH_OPTIONS, signal }));
          const reads = [
            (yield* send()).text(),
            (yield* send()).json(),
            Promise.resolve((yield* send()).body?.getReader().read()),
          ];
          return { signal, reads };
        }),
      );

      const outcomes = yield* Effect.promise(() => Promise.allSettled(reads));
      expect(outcomes).toEqual(
        Array.from({ length: 3 }, () => ({ status: "rejected", reason: signal.reason })),
      );
      yield* Effect.forEach(transportAborts, Deferred.await).pipe(Effect.timeout("2 seconds"));
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request, _url, signal) =>
            Effect.gen(function* () {
              const aborted = yield* Deferred.make<void>();
              signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void), {
                once: true,
              });
              transportAborts.push(aborted);
              return HttpClientResponse.fromWeb(request, new Response(new ReadableStream()));
            }),
          ),
        ),
      ),
    );
  });

  it.live("reads a null body the way native fetch does", () =>
    Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const send = () => Effect.promise(() => posthogFetch(BATCH_URL, BATCH_OPTIONS));
      const reads = [(yield* send()).text(), (yield* send()).json()];
      const nativeReads = [
        new Response(null, { status: 204 }).text(),
        new Response(null, { status: 204 }).json(),
      ];

      const [text, json] = yield* Effect.promise(() => Promise.allSettled(reads));
      const [nativeText, nativeJson] = yield* Effect.promise(() => Promise.allSettled(nativeReads));
      expect(text).toEqual(nativeText);
      expect(nativeText).toEqual({ status: "fulfilled", value: "" });
      expect(json).toEqual({ status: "rejected", reason: expect.any(SyntaxError) });
      expect(nativeJson).toEqual({ status: "rejected", reason: expect.any(SyntaxError) });
    }).pipe(Effect.provide(respondingClient(() => new Response(null, { status: 204 })))),
  );

  it.live("reports success when the network is unreachable", () =>
    Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const response = yield* Effect.promise(() => posthogFetch(BATCH_URL, BATCH_OPTIONS));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("");
      expect(yield* Effect.promise(() => response.json())).toEqual({});
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("connect ECONNREFUSED"),
                }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.live("reports success on error responses so the SDK never retries or logs", () =>
    Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const response = yield* Effect.promise(() => posthogFetch(BATCH_URL, BATCH_OPTIONS));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("");
    }).pipe(
      Effect.provide(
        respondingClient(() => new Response("Proxy Authentication Required", { status: 407 })),
      ),
    ),
  );
});

describe("scopedPosthogClient", () => {
  it.live("captures and shuts down cleanly against an unreachable host", () =>
    Effect.gen(function* () {
      const client = yield* scopedPosthogClient("phc_test", "http://127.0.0.1:9");
      expect(client).toBeInstanceOf(PostHog);
      client.capture({ event: "verify_event", distinctId: "device-1" });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.live(
    "bounds the whole shutdown when a request is in flight and another event is queued",
    () =>
      Effect.gen(function* () {
        const firstRequestInFlight = yield* Deferred.make<void>();
        const drainSettled = yield* Deferred.make<void>();
        const activeRequests = yield* Ref.make(0);
        const hangingClient = HttpClient.make(() =>
          Effect.acquireUseRelease(
            Ref.update(activeRequests, (count) => count + 1),
            () =>
              Deferred.succeed(firstRequestInFlight, undefined).pipe(
                Effect.andThen((first) =>
                  first ? Effect.void : Deferred.succeed(drainSettled, undefined),
                ),
                Effect.andThen(Effect.never),
              ),
            () => Ref.update(activeRequests, (count) => count - 1),
          ),
        );

        const startedAt = performance.now();
        yield* Effect.gen(function* () {
          const client = yield* scopedPosthogClient("phc_test", "https://blackhole.invalid");
          client.on("flush", (messages: ReadonlyArray<{ readonly event: string }>) => {
            if (messages.some(({ event }) => event === "second_event")) {
              Deferred.doneUnsafe(drainSettled, Effect.void);
            }
          });
          client.capture({ event: "first_event", distinctId: "device-1" });
          yield* Deferred.await(firstRequestInFlight);
          client.capture({ event: "second_event", distinctId: "device-1" });
        }).pipe(Effect.scoped, Effect.provideService(HttpClient.HttpClient, hangingClient));

        expect(performance.now() - startedAt).toBeLessThan(3_000);

        // The SDK's drain keeps running past the shutdown deadline; without
        // cancellation it starts the queued request AFTER scope release and
        // keeps the process alive for that request's own timeout.
        yield* Deferred.await(drainSettled).pipe(
          Effect.timeoutOrElse({
            duration: "6 seconds",
            orElse: () => Effect.die(new Error("SDK drain never settled after shutdown")),
          }),
        );
        expect(yield* Ref.get(activeRequests)).toBe(0);
      }),
    10_000,
  );
});

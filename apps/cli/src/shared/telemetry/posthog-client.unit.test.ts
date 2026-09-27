import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";
import { PostHog } from "posthog-node";
import { makePosthogFetch, scopedPosthogClient } from "./posthog-client.ts";

const BATCH_URL = "https://eu.i.posthog.com/batch/";
const BATCH_OPTIONS = { method: "POST" as const, headers: {}, body: "{}" };

const respondingClient = (response: Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response))),
  );

describe("makePosthogFetch", () => {
  it.live("passes successful responses through untouched", () =>
    Effect.gen(function* () {
      const posthogFetch = makePosthogFetch(yield* Effect.context<HttpClient.HttpClient>());
      const response = yield* Effect.promise(() => posthogFetch(BATCH_URL, BATCH_OPTIONS));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe(`{"status":1}`);
    }).pipe(Effect.provide(respondingClient(new Response(`{"status":1}`, { status: 200 })))),
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
        respondingClient(new Response("Proxy Authentication Required", { status: 407 })),
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
        const activeRequests = yield* Ref.make(0);
        const hangingClient = HttpClient.make(() =>
          Effect.acquireUseRelease(
            Ref.update(activeRequests, (count) => count + 1),
            () =>
              Deferred.succeed(firstRequestInFlight, undefined).pipe(Effect.andThen(Effect.never)),
            () => Ref.update(activeRequests, (count) => count - 1),
          ),
        );

        const startedAt = performance.now();
        yield* Effect.gen(function* () {
          const client = yield* scopedPosthogClient("phc_test", "https://blackhole.invalid");
          client.capture({ event: "first_event", distinctId: "device-1" });
          yield* Deferred.await(firstRequestInFlight);
          client.capture({ event: "second_event", distinctId: "device-1" });
        }).pipe(Effect.scoped, Effect.provideService(HttpClient.HttpClient, hangingClient));

        expect(performance.now() - startedAt).toBeLessThan(3_000);

        // The SDK's drain keeps running past the shutdown deadline; without
        // cancellation it starts the queued request AFTER scope release and
        // keeps the process alive for that request's own timeout.
        yield* Effect.sleep("50 millis");
        expect(yield* Ref.get(activeRequests)).toBe(0);
      }),
    10_000,
  );
});

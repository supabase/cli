import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect } from "effect";
import { PostHog } from "posthog-node";
import { makeFireAndForgetFetch, scopedPosthogClient } from "./posthog-client.ts";

const BATCH_URL = "https://eu.i.posthog.com/batch/";
const BATCH_OPTIONS = { method: "POST" as const, headers: {}, body: "{}" };

class PosthogTestError extends Data.TaggedError("PosthogTestError")<{
  readonly message: string;
}> {}

const makeBlackholeFetch =
  (
    requestStarted: Deferred.Deferred<void>,
    requestAborted: Deferred.Deferred<void>,
    activeRequests: { value: number },
  ) =>
  (_url: string | URL, options: RequestInit) =>
    Effect.runPromise(
      Effect.callback<Response, PosthogTestError>((resume, signal) => {
        activeRequests.value += 1;
        Effect.runSync(Deferred.succeed(requestStarted, undefined));
        let completed = false;
        const abort = () => {
          if (completed) return;
          completed = true;
          activeRequests.value -= 1;
          Effect.runSync(Deferred.succeed(requestAborted, undefined));
          resume(Effect.fail(new PosthogTestError({ message: "The operation was aborted." })));
        };
        if (options.signal?.aborted) {
          abort();
        } else {
          options.signal?.addEventListener("abort", abort);
          signal.addEventListener("abort", abort);
        }
        return Effect.sync(() => {
          options.signal?.removeEventListener("abort", abort);
          signal.removeEventListener("abort", abort);
        });
      }),
    );

describe("fireAndForgetFetch", () => {
  it("passes successful responses through untouched", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetch = () => Promise.resolve(new Response(`{"status":1}`, { status: 200 }));

        const response = yield* Effect.tryPromise(() =>
          makeFireAndForgetFetch(fetch)(BATCH_URL, BATCH_OPTIONS),
        );

        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.text())).toBe(`{"status":1}`);
      }),
    ));

  it("reports success when the network is unreachable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetch = () => Promise.reject(new Error("connect ECONNREFUSED"));

        const response = yield* Effect.tryPromise(() =>
          makeFireAndForgetFetch(fetch)(BATCH_URL, BATCH_OPTIONS),
        );

        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.text())).toBe("");
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({});
      }),
    ));

  it("reports success on error responses so the SDK never retries or logs", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetch = () =>
          Promise.resolve(new Response("Proxy Authentication Required", { status: 407 }));

        const response = yield* Effect.tryPromise(() =>
          makeFireAndForgetFetch(fetch)(BATCH_URL, BATCH_OPTIONS),
        );

        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.text())).toBe("");
      }),
    ));
});

describe("scopedPosthogClient", () => {
  it.live("captures and shuts down cleanly against an unreachable host", () =>
    Effect.gen(function* () {
      const client = yield* scopedPosthogClient("phc_test", "http://127.0.0.1:9");
      expect(client).toBeInstanceOf(PostHog);
      client.capture({ event: "verify_event", distinctId: "device-1" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "bounds the whole shutdown when a request is in flight and another event is queued",
    () =>
      Effect.gen(function* () {
        const firstRequestInFlight: Deferred.Deferred<void, never> = yield* Deferred.make<
          void,
          never
        >();
        const firstRequestAborted = yield* Deferred.make<void>();
        const activeRequests = { value: 0 };
        const fetch = makeBlackholeFetch(firstRequestInFlight, firstRequestAborted, activeRequests);

        const startedAt = performance.now();
        const clientProgram = scopedPosthogClient("phc_test", "https://blackhole.invalid", fetch);
        const runClient = Effect.scoped(
          clientProgram.pipe(
            Effect.tap((client) =>
              Effect.sync(() => {
                client.capture({ event: "first_event", distinctId: "device-1" });
              }),
            ),
            Effect.flatMap((client) =>
              Deferred.await(firstRequestInFlight).pipe(Effect.as(client)),
            ),
            Effect.tap((client) =>
              Effect.sync(() => {
                client.capture({ event: "second_event", distinctId: "device-1" });
              }),
            ),
            Effect.asVoid,
          ),
        );
        yield* runClient;

        expect(performance.now() - startedAt).toBeLessThan(3_000);

        // Scope release must not return until its owned in-flight request has
        // observed cancellation. Any queued request inherits the already-
        // aborted shutdown signal and therefore cannot stay active either.
        yield* Deferred.await(firstRequestAborted);
        expect(activeRequests.value).toBe(0);
      }),
    10_000,
  );
});

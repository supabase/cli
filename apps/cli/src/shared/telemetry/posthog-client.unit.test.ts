import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect } from "effect";
import { PostHog } from "posthog-node";
import { fireAndForgetFetch, scopedPosthogClient } from "./posthog-client.ts";

const BATCH_URL = "https://eu.i.posthog.com/batch/";
const BATCH_OPTIONS = { method: "POST" as const, headers: {}, body: "{}" };

describe("fireAndForgetFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes successful responses through untouched", async () => {
    vi.stubGlobal("fetch", async () => new Response(`{"status":1}`, { status: 200 }));

    const response = await fireAndForgetFetch(BATCH_URL, BATCH_OPTIONS);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`{"status":1}`);
  });

  it("reports success when the network is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const response = await fireAndForgetFetch(BATCH_URL, BATCH_OPTIONS);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await response.json()).toEqual({});
  });

  it("reports success on error responses so the SDK never retries or logs", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("Proxy Authentication Required", { status: 407 }),
    );

    const response = await fireAndForgetFetch(BATCH_URL, BATCH_OPTIONS);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("scopedPosthogClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
        let requestStarted = () => {};
        const firstRequestInFlight = new Promise<void>((resolve) => {
          requestStarted = resolve;
        });
        let activeRequests = 0;
        vi.stubGlobal(
          "fetch",
          (_url: string, options: { signal?: AbortSignal }) =>
            new Promise<Response>((_resolve, reject) => {
              activeRequests += 1;
              requestStarted();
              const abort = () => {
                activeRequests -= 1;
                reject(new DOMException("The operation was aborted.", "AbortError"));
              };
              if (options.signal?.aborted) {
                abort();
                return;
              }
              options.signal?.addEventListener("abort", abort);
            }),
        );

        const startedAt = performance.now();
        yield* Effect.gen(function* () {
          const client = yield* scopedPosthogClient("phc_test", "https://blackhole.invalid");
          client.capture({ event: "first_event", distinctId: "device-1" });
          yield* Effect.promise(() => firstRequestInFlight);
          client.capture({ event: "second_event", distinctId: "device-1" });
        }).pipe(Effect.scoped);

        expect(performance.now() - startedAt).toBeLessThan(3_000);

        // The SDK's drain keeps running past the shutdown deadline; without
        // cancellation it starts the queued request AFTER scope release and
        // keeps the process alive for that request's own timeout.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(activeRequests).toBe(0);
      }),
    10_000,
  );
});

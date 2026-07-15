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
  it.live("captures and shuts down cleanly against an unreachable host", () =>
    Effect.gen(function* () {
      const client = yield* scopedPosthogClient("phc_test", "http://127.0.0.1:9");
      expect(client).toBeInstanceOf(PostHog);
      client.capture({ event: "verify_event", distinctId: "device-1" });
    }).pipe(Effect.scoped),
  );
});

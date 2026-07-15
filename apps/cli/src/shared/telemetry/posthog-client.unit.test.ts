import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PostHog } from "posthog-node";
import { fireAndForgetFetch, scopedPosthogClient } from "./posthog-client.ts";

const BATCH_URL = "https://eu.i.posthog.com/batch/";
const BATCH_OPTIONS = { method: "POST" as const, headers: {}, body: "{}" };

describe("fireAndForgetFetch", () => {
  it("passes successful responses through untouched", async () => {
    const fetchImpl = async () => new Response(`{"status":1}`, { status: 200 });

    const response = await fireAndForgetFetch(fetchImpl)(BATCH_URL, BATCH_OPTIONS);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`{"status":1}`);
  });

  it("reports success when the network is unreachable", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("connect ECONNREFUSED");
    };

    const response = await fireAndForgetFetch(fetchImpl)(BATCH_URL, BATCH_OPTIONS);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await response.json()).toEqual({});
  });

  it("reports success on error responses so the SDK never retries or logs", async () => {
    const fetchImpl = async () => new Response("Proxy Authentication Required", { status: 407 });

    const response = await fireAndForgetFetch(fetchImpl)(BATCH_URL, BATCH_OPTIONS);

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

import { describe, expect, it } from "@effect/vitest";
import { fireAndForgetFetch } from "./posthog-client.ts";

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

import { describe, expect, it } from "vitest";
import { makeEnsureServiceMemo } from "./lazyServices.ts";

describe("makeEnsureServiceMemo", () => {
  it("starts a service once across concurrent calls", async () => {
    let starts = 0;
    const ensure = makeEnsureServiceMemo(async (_name) => {
      starts += 1;
      await new Promise((r) => setTimeout(r, 10));
    });
    await Promise.all([ensure("realtime"), ensure("realtime"), ensure("realtime")]);
    expect(starts).toBe(1);
  });

  it("retries after a failed start", async () => {
    let attempt = 0;
    const ensure = makeEnsureServiceMemo(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
    });
    await expect(ensure("auth")).rejects.toThrow("boom");
    await ensure("auth"); // second attempt allowed
    expect(attempt).toBe(2);
  });

  it("checks again after a completed start", async () => {
    let starts = 0;
    const ensure = makeEnsureServiceMemo(async (_name) => {
      starts += 1;
    });
    await ensure("storage");
    await ensure("storage");
    await ensure("storage");
    expect(starts).toBe(3);
  });

  it("tracks each service name independently", async () => {
    const seen: string[] = [];
    const ensure = makeEnsureServiceMemo(async (name) => {
      seen.push(name);
    });
    await Promise.all([ensure("realtime"), ensure("storage")]);
    expect(seen.sort()).toEqual(["realtime", "storage"]);
  });
});

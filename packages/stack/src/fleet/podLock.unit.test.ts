import { describe, expect, it } from "vitest";
import { PodLock } from "./podLock.ts";

describe("PodLock", () => {
  it("serializes operations for the same id in call order", async () => {
    const lock = new PodLock();
    const order: string[] = [];

    const first = lock.withLock("a", async () => {
      order.push("first-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("first-end");
      return 1;
    });
    const second = lock.withLock("a", async () => {
      order.push("second-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("second-end");
      return 2;
    });

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("does not let a rejected op poison the chain for subsequent ops", async () => {
    const lock = new PodLock();

    await expect(
      lock.withLock("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A later op on the same id must still run (and run after the failure).
    const order: string[] = [];
    await lock.withLock("a", async () => {
      order.push("ran");
    });
    expect(order).toEqual(["ran"]);
  });

  it("does not serialize operations across different ids", async () => {
    const lock = new PodLock();
    const order: string[] = [];

    const a = lock.withLock("a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = lock.withLock("b", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("b-end");
    });

    await Promise.all([a, b]);
    // b, on a different id, should complete before a (which sleeps longer),
    // proving the two chains ran concurrently rather than serialized.
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
    expect(order).toContain("a-start");
    expect(order).toContain("b-start");
  });

  it("clears the internal chain entry once settled (no unbounded growth)", async () => {
    const lock = new PodLock();
    await lock.withLock("a", async () => {});
    expect(lock.size).toBe(0);
  });

  it("preserves order across many interleaved ops on the same id", async () => {
    const lock = new PodLock();
    const results: number[] = [];
    const ops = Array.from({ length: 10 }, (_, i) =>
      lock.withLock("a", async () => {
        await new Promise((r) => setTimeout(r, (10 - i) % 3));
        results.push(i);
      }),
    );
    await Promise.all(ops);
    expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });
});

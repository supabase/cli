import { describe, expect, it } from "vitest";

import { throwWithCleanup } from "./live.ts";

describe("throwWithCleanup", () => {
  it("rethrows the primary failure when cleanup succeeds", () => {
    const primary = new Error("target failed");

    expect(() => throwWithCleanup(primary, [])).toThrow(primary);
  });

  it("throws the cleanup failure when the target succeeds", () => {
    const cleanup = new Error("cleanup failed");

    expect(() => throwWithCleanup(undefined, [cleanup])).toThrow(cleanup);
  });

  it("preserves the primary and every cleanup failure", () => {
    const primary = new Error("target failed");
    const cleanup = [new Error("first cleanup failed"), new Error("second cleanup failed")];
    let thrown: unknown;

    try {
      throwWithCleanup(primary, cleanup);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) return;
    expect(thrown.errors).toEqual([primary, ...cleanup]);
  });
});

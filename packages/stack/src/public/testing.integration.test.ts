import { describe, expect, it } from "@effect/vitest";
import { createTestStack } from "../testing.ts";

describe("test stack resource", () => {
  it("is the sole async-disposable stack resource", () => {
    expect(typeof createTestStack).toBe("function");
  });
});

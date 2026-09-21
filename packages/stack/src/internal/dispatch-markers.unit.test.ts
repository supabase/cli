import { describe, expect, it } from "vitest";
import { isBunVirtualPath } from "./dispatch-markers.ts";

describe("isBunVirtualPath", () => {
  it.each([
    "file:///$bunfs/root/entry.ts",
    "file:///B:/~BUN/root/entry.ts",
    "B:\\~BUN\\root\\entry.ts",
  ])("recognizes %s", (value) => {
    expect(isBunVirtualPath(value)).toBe(true);
  });

  it("does not treat source files as virtual", () => {
    expect(isBunVirtualPath("file:///workspace/src/entry.ts")).toBe(false);
  });
});

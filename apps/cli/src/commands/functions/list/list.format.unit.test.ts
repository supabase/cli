import { describe, expect, it } from "vitest";

import { formatUnixMilliTimestamp } from "./list.format.ts";

describe("formatUnixMilliTimestamp", () => {
  it("formats unix milliseconds in UTC", () => {
    expect(formatUnixMilliTimestamp(1_687_423_025_152)).toBe("2023-06-22 08:37:05");
  });

  it("pads single-digit UTC components", () => {
    expect(formatUnixMilliTimestamp(Date.UTC(2024, 0, 2, 3, 4, 5))).toBe("2024-01-02 03:04:05");
  });
});

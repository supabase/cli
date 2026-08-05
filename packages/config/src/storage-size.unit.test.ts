import { describe, expect, it } from "vitest";
import { InvalidStorageSizeError, parseStorageSizeBytes } from "./storage-size.ts";

describe("parseStorageSizeBytes", () => {
  it.each([
    ["5000000", 5_000_000],
    ["5MiB", 5_242_880],
    ["5GB", 5_368_709_120],
  ])("parses %s", (input, expected) => {
    expect(parseStorageSizeBytes(input)).toBe(expected);
  });

  it("does not include the input in parse errors", () => {
    const privateValue = "private-invalid-size";
    try {
      parseStorageSizeBytes(privateValue);
      throw new Error("expected parser failure");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStorageSizeError);
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
  });
});

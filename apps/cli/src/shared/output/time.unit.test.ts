import { describe, expect, it } from "vitest";
import { formatUtcDate, formatUtcTime } from "./time.ts";

describe("formatUtcDate", () => {
  it("extracts the date portion from an ISO string", () => {
    expect(formatUtcDate("2024-01-15T10:30:00.000Z")).toBe("2024-01-15");
  });

  it("handles end-of-year dates", () => {
    expect(formatUtcDate("2024-12-31T23:59:59.000Z")).toBe("2024-12-31");
  });
});

describe("formatUtcTime", () => {
  it("formats the time portion with UTC suffix", () => {
    expect(formatUtcTime("2024-01-15T10:30:00.000Z")).toBe("10:30:00 UTC");
  });

  it("handles midnight UTC", () => {
    expect(formatUtcTime("2024-03-20T00:00:00.000Z")).toBe("00:00:00 UTC");
  });
});

import { describe, expect, it } from "vitest";

import { formatLegacyTimestamp } from "./legacy-timestamp.format.ts";

describe("formatLegacyTimestamp", () => {
  it("formats valid RFC3339 to YYYY-MM-DD HH:MM:SS UTC", () => {
    expect(formatLegacyTimestamp("2026-02-08T16:44:07Z")).toBe("2026-02-08 16:44:07");
  });

  it("handles offsets by normalizing to UTC", () => {
    expect(formatLegacyTimestamp("2026-02-08T18:44:07+02:00")).toBe("2026-02-08 16:44:07");
  });

  it("falls back to the original value for already-formatted timestamps", () => {
    // Go's time.Parse(time.RFC3339, ...) rejects "2026-02-08 16:44:07" (space, not T).
    expect(formatLegacyTimestamp("2026-02-08 16:44:07")).toBe("2026-02-08 16:44:07");
  });

  it("falls back for malformed input", () => {
    expect(formatLegacyTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("returns empty string unchanged", () => {
    expect(formatLegacyTimestamp("")).toBe("");
  });
});

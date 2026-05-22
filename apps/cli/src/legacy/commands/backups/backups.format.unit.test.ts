import { describe, expect, it } from "vitest";

import { formatBackupTimestamp, formatRegion } from "./backups.format.ts";

describe("formatRegion", () => {
  it.each([
    ["ap-east-1", "East Asia (Hong Kong)"],
    ["ap-northeast-1", "Northeast Asia (Tokyo)"],
    ["ap-northeast-2", "Northeast Asia (Seoul)"],
    ["ap-south-1", "South Asia (Mumbai)"],
    ["ap-southeast-1", "Southeast Asia (Singapore)"],
    ["ap-southeast-2", "Oceania (Sydney)"],
    ["ca-central-1", "Canada (Central)"],
    ["eu-central-1", "Central EU (Frankfurt)"],
    ["eu-central-2", "Central Europe (Zurich)"],
    ["eu-north-1", "North EU (Stockholm)"],
    ["eu-west-1", "West EU (Ireland)"],
    ["eu-west-2", "West Europe (London)"],
    ["eu-west-3", "West EU (Paris)"],
    ["sa-east-1", "South America (São Paulo)"],
    ["us-east-1", "East US (North Virginia)"],
    ["us-east-2", "East US (Ohio)"],
    ["us-west-1", "West US (North California)"],
    ["us-west-2", "West US (Oregon)"],
  ])("maps %s to %s", (input, expected) => {
    expect(formatRegion(input)).toBe(expected);
  });

  it("returns the region unchanged when unknown", () => {
    expect(formatRegion("xx-unknown-9")).toBe("xx-unknown-9");
  });
});

describe("formatBackupTimestamp", () => {
  it("formats valid RFC3339 to YYYY-MM-DD HH:MM:SS UTC", () => {
    expect(formatBackupTimestamp("2026-02-08T16:44:07Z")).toBe("2026-02-08 16:44:07");
  });

  it("handles offsets by normalizing to UTC", () => {
    expect(formatBackupTimestamp("2026-02-08T18:44:07+02:00")).toBe("2026-02-08 16:44:07");
  });

  it("falls back to the original value for already-formatted timestamps", () => {
    // Go's time.Parse(time.RFC3339, ...) rejects "2026-02-08 16:44:07" (space, not T).
    expect(formatBackupTimestamp("2026-02-08 16:44:07")).toBe("2026-02-08 16:44:07");
  });

  it("falls back for malformed input", () => {
    expect(formatBackupTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("returns empty string unchanged", () => {
    expect(formatBackupTimestamp("")).toBe("");
  });
});

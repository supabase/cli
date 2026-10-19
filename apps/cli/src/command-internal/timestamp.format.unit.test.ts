import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { formatTimestamp } from "./timestamp.format.ts";

describe("formatTimestamp", () => {
  it("formats valid RFC3339 to YYYY-MM-DD HH:MM:SS UTC", () => {
    expect(formatTimestamp("2026-02-08T16:44:07Z")).toBe("2026-02-08 16:44:07");
  });

  it("handles offsets by normalizing to UTC", () => {
    expect(formatTimestamp("2026-02-08T18:44:07+02:00")).toBe("2026-02-08 16:44:07");
  });

  it("falls back to the original value for already-formatted timestamps", () => {
    // RFC3339 parsing rejects "2026-02-08 16:44:07" (space, not T).
    expect(formatTimestamp("2026-02-08 16:44:07")).toBe("2026-02-08 16:44:07");
  });

  it("falls back for malformed input", () => {
    expect(formatTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
    expect(formatTimestamp("2024-13-01T00:00:00Z")).toBe("2024-13-01T00:00:00Z");
  });

  it.effect("reads a zone-less value as local time", () =>
    withEnvVar(
      "TZ",
      "Asia/Kolkata",
      Effect.sync(() => {
        expect(formatTimestamp("2026-02-08T16:44:07")).toBe("2026-02-08 11:14:07");
      }),
    ),
  );

  it("returns empty string unchanged", () => {
    expect(formatTimestamp("")).toBe("");
  });
});

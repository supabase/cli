import { describe, expect, it } from "vitest";
import { legacyParseBearerJwtExp, legacyParseBearerJwtValidFor } from "./bearer-jwt.flags.ts";

describe("legacyParseBearerJwtExp", () => {
  it("parses a UTC RFC3339 timestamp to Unix seconds", () => {
    expect(legacyParseBearerJwtExp("2020-01-01T00:00:00Z")).toBe(1_577_836_800);
  });

  it("honors a non-zero numeric offset", () => {
    // "+05:00" means local wall-clock time is 5 hours AHEAD of UTC, so the same wall
    // time is an EARLIER instant than at "Z" — verified against the real binary
    // (CLI-1961): 2030-01-01T00:00:00+05:00 -> exp 1893438000, ...Z -> exp 1893456000.
    const withOffset = legacyParseBearerJwtExp("2030-01-01T00:00:00+05:00");
    const atZ = legacyParseBearerJwtExp("2030-01-01T00:00:00Z");
    expect(withOffset).toBe(atZ - 5 * 60 * 60);
  });

  it("rejects a malformed value with pflag's exact wrapped message", () => {
    expect(() => legacyParseBearerJwtExp("notatime")).toThrow(
      'invalid argument "notatime" for "--exp" flag: invalid time format `notatime` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("rejects a value missing the required timezone offset", () => {
    expect(() => legacyParseBearerJwtExp("2020-01-01T00:00:00")).toThrow(
      'invalid argument "2020-01-01T00:00:00" for "--exp" flag:',
    );
  });
});

describe("legacyParseBearerJwtValidFor", () => {
  it("parses a Go duration string to whole seconds", () => {
    expect(legacyParseBearerJwtValidFor("30m")).toBe(1800);
    expect(legacyParseBearerJwtValidFor("1h")).toBe(3600);
  });

  it("accepts a negative duration, matching Go's unchecked arithmetic", () => {
    expect(legacyParseBearerJwtValidFor("-5m")).toBe(-300);
  });

  it("rejects a malformed value with pflag's exact wrapped message", () => {
    expect(() => legacyParseBearerJwtValidFor("xyz")).toThrow(
      'invalid argument "xyz" for "--valid-for" flag: time: invalid duration "xyz"',
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  addSecondsAndFloor,
  parseBearerJwtExp,
  parseBearerJwtValidFor,
} from "./bearer-jwt.flags.ts";

describe("parseBearerJwtExp", () => {
  it("parses a UTC RFC3339 timestamp to Unix seconds", () => {
    expect(parseBearerJwtExp("2020-01-01T00:00:00Z")).toEqual({
      wholeSeconds: 1_577_836_800,
      nanos: 0,
    });
  });

  it("honors a non-zero numeric offset", () => {
    // A +05:00 offset means the wall-clock time is 5 hours ahead of UTC, so
    // the same wall time is an earlier instant than at "Z".
    const withOffset = parseBearerJwtExp("2030-01-01T00:00:00+05:00");
    const atZ = parseBearerJwtExp("2030-01-01T00:00:00Z");
    expect(withOffset).toEqual({ wholeSeconds: atZ.wholeSeconds - 5 * 60 * 60, nanos: 0 });
  });

  it("rejects a malformed value with pflag's exact wrapped message", () => {
    expect(() => parseBearerJwtExp("notatime")).toThrow(
      'invalid argument "notatime" for "--exp" flag: invalid time format `notatime` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("rejects a value missing the required timezone offset", () => {
    expect(() => parseBearerJwtExp("2020-01-01T00:00:00")).toThrow(
      'invalid argument "2020-01-01T00:00:00" for "--exp" flag:',
    );
  });

  it("rejects an invalid calendar date instead of silently rolling it over (CLI-1961)", () => {
    expect(() => parseBearerJwtExp("2030-02-30T03:04:05Z")).toThrow(
      'invalid argument "2030-02-30T03:04:05Z" for "--exp" flag: invalid time format `2030-02-30T03:04:05Z` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("rejects February 29th in a non-leap year but accepts it in a leap year", () => {
    expect(() => parseBearerJwtExp("1900-02-29T00:00:00Z")).toThrow(
      'invalid argument "1900-02-29T00:00:00Z" for "--exp" flag:',
    );
    expect(parseBearerJwtExp("2000-02-29T00:00:00Z")).toEqual({
      wholeSeconds: 951782400,
      nanos: 0,
    });
  });

  it("rejects an out-of-range hour/minute/second the same way Go's time.Parse does", () => {
    expect(() => parseBearerJwtExp("2030-01-01T25:00:00Z")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => parseBearerJwtExp("2030-01-01T00:60:00Z")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => parseBearerJwtExp("2030-01-01T00:00:60Z")).toThrow(
      '"--exp" flag: invalid time format',
    );
  });

  it("trims surrounding whitespace before parsing, matching pflag's strings.TrimSpace", () => {
    expect(parseBearerJwtExp(" 2030-01-01T00:00:00Z ")).toEqual(
      parseBearerJwtExp("2030-01-01T00:00:00Z"),
    );
  });

  it("embeds the TRIMMED value (not the raw argument) in the error message", () => {
    expect(() => parseBearerJwtExp(" notatime ")).toThrow(
      'invalid argument "notatime" for "--exp" flag: invalid time format `notatime` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("rejects an out-of-range zone offset instead of silently signing a null exp/iat (CLI-1961 Codex review finding)", () => {
    expect(() => parseBearerJwtExp("2030-01-01T00:00:00+99:99")).toThrow(
      'invalid argument "2030-01-01T00:00:00+99:99" for "--exp" flag: invalid time format `2030-01-01T00:00:00+99:99` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("tolerates a 24-hour/60-minute offset the same way Go's time.Parse does (`>` not `>=`)", () => {
    expect(parseBearerJwtExp("2030-01-01T00:00:00+24:00")).toEqual({
      wholeSeconds: parseBearerJwtExp("2030-01-01T00:00:00Z").wholeSeconds - 24 * 60 * 60,
      nanos: 0,
    });
    expect(parseBearerJwtExp("2030-01-01T00:00:00+00:60")).toEqual({
      wholeSeconds: parseBearerJwtExp("2030-01-01T00:00:00Z").wholeSeconds - 60 * 60,
      nanos: 0,
    });
  });

  it("rejects an offset that overflows even Go's 24-hour/60-minute tolerance", () => {
    expect(() => parseBearerJwtExp("2030-01-01T00:00:00+25:00")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => parseBearerJwtExp("2030-01-01T00:00:00+00:61")).toThrow(
      '"--exp" flag: invalid time format',
    );
  });

  it("preserves fractional seconds instead of dropping them during parsing (CLI-1961 Codex review finding)", () => {
    expect(parseBearerJwtExp("2030-01-01T00:00:00.9Z")).toEqual({
      wholeSeconds: 1_893_456_000,
      nanos: 900_000_000,
    });
  });

  it("preserves a fractional offset the same way for a non-UTC zone", () => {
    const withFraction = parseBearerJwtExp("2030-01-01T00:00:00.5+05:00");
    const atZ = parseBearerJwtExp("2030-01-01T00:00:00Z");
    expect(withFraction).toEqual({
      wholeSeconds: atZ.wholeSeconds - 5 * 60 * 60,
      nanos: 500_000_000,
    });
  });

  it("preserves a near-second nanosecond fraction as an exact integer instead of rounding it into the next second (CLI-1961 Codex review finding)", () => {
    expect(parseBearerJwtExp("2030-01-01T00:00:00.999999999Z")).toEqual({
      wholeSeconds: 1_893_456_000,
      nanos: 999_999_999,
    });
  });

  it("truncates (not rounds) fractional digits beyond nanosecond precision, matching Go's time.Parse", () => {
    expect(parseBearerJwtExp("2030-01-01T00:00:00.9999999995Z")).toEqual({
      wholeSeconds: 1_893_456_000,
      nanos: 999_999_999,
    });
  });

  it("accepts a comma as the fractional-seconds separator, matching Go's time.Parse (CLI-1961 Codex review finding)", () => {
    expect(parseBearerJwtExp("2030-01-01T00:00:00,5Z")).toEqual(
      parseBearerJwtExp("2030-01-01T00:00:00.5Z"),
    );
  });

  it("accepts a comma fraction alongside a non-UTC zone offset too", () => {
    expect(parseBearerJwtExp("2030-01-01T00:00:00,5+05:00")).toEqual(
      parseBearerJwtExp("2030-01-01T00:00:00.5+05:00"),
    );
  });

  it("parses an early (0000-0099) RFC3339 year literally instead of applying JS's two-digit-year remapping (CLI-1961 Codex review finding)", () => {
    expect(parseBearerJwtExp("0001-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -62_135_596_800,
      nanos: 0,
    });
    expect(parseBearerJwtExp("0099-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -59_042_995_200,
      nanos: 0,
    });
    expect(parseBearerJwtExp("0000-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -62_167_219_200,
      nanos: 0,
    });
  });

  it("still parses years at and above 0100 the same way as before (no regression from the year-remapping fix)", () => {
    expect(parseBearerJwtExp("0100-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -59_011_459_200,
      nanos: 0,
    });
  });
});

describe("parseBearerJwtValidFor", () => {
  it("parses a Go duration string to whole seconds", () => {
    expect(parseBearerJwtValidFor("30m")).toBe(1800);
    expect(parseBearerJwtValidFor("1h")).toBe(3600);
  });

  it("accepts a negative duration, matching Go's unchecked arithmetic", () => {
    expect(parseBearerJwtValidFor("-5m")).toBe(-300);
  });

  it("preserves sub-second precision instead of flooring it away (CLI-1961)", () => {
    expect(parseBearerJwtValidFor("1.5s")).toBe(1.5);
  });

  it("rejects a malformed value with pflag's exact wrapped message", () => {
    expect(() => parseBearerJwtValidFor("xyz")).toThrow(
      'invalid argument "xyz" for "--valid-for" flag: time: invalid duration "xyz"',
    );
  });

  it("does NOT trim surrounding whitespace, unlike --exp (pflag's duration Value.Set has no TrimSpace)", () => {
    expect(() => parseBearerJwtValidFor(" 30m ")).toThrow(
      'invalid argument " 30m " for "--valid-for" flag: time: invalid duration " 30m "',
    );
  });

  it("accepts the Greek-mu microsecond spelling, matching Go's time.ParseDuration (CLI-1961 Codex review finding)", () => {
    // Accepts both U+00B5 (µ, micro sign) and U+03BC (μ, Greek mu).
    expect(parseBearerJwtValidFor("1μs")).toBe(0.000_001);
  });
});

describe("addSecondsAndFloor", () => {
  it("adds a whole-second delta with no carry", () => {
    expect(addSecondsAndFloor({ wholeSeconds: 100, nanos: 0 }, 5)).toBe(105);
  });

  it("carries into the next second when nanos overflow 1e9", () => {
    expect(addSecondsAndFloor({ wholeSeconds: 100, nanos: 900_000_000 }, 0.2)).toBe(101);
  });

  it("borrows from the previous second when the combined nanos go negative", () => {
    expect(addSecondsAndFloor({ wholeSeconds: 100, nanos: 200_000_000 }, -0.5)).toBe(99);
  });

  it("never rounds an epoch-scale whole-second count up via float addition (CLI-1961 Codex review finding)", () => {
    expect(addSecondsAndFloor({ wholeSeconds: 1_893_456_000, nanos: 999_999_999 }, 0)).toBe(
      1_893_456_000,
    );
  });
});

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

  it("rejects an invalid calendar date instead of silently rolling it over (CLI-1961)", () => {
    // Verified directly against Go's `time.Parse`: `2030-02-30` genuinely errors
    // ("day out of range"), it does NOT roll over to March 2nd the way `Date.parse`
    // does — Go's pflag wrapper discards that specific error text and falls back to
    // the same generic message used for a syntactically-malformed value.
    expect(() => legacyParseBearerJwtExp("2030-02-30T03:04:05Z")).toThrow(
      'invalid argument "2030-02-30T03:04:05Z" for "--exp" flag: invalid time format `2030-02-30T03:04:05Z` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("rejects February 29th in a non-leap year but accepts it in a leap year", () => {
    expect(() => legacyParseBearerJwtExp("1900-02-29T00:00:00Z")).toThrow(
      'invalid argument "1900-02-29T00:00:00Z" for "--exp" flag:',
    );
    expect(legacyParseBearerJwtExp("2000-02-29T00:00:00Z")).toBe(951782400);
  });

  it("rejects an out-of-range hour/minute/second the same way Go's time.Parse does", () => {
    expect(() => legacyParseBearerJwtExp("2030-01-01T25:00:00Z")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:60:00Z")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:00:60Z")).toThrow(
      '"--exp" flag: invalid time format',
    );
  });

  it("trims surrounding whitespace before parsing, matching pflag's strings.TrimSpace", () => {
    expect(legacyParseBearerJwtExp(" 2030-01-01T00:00:00Z ")).toBe(
      legacyParseBearerJwtExp("2030-01-01T00:00:00Z"),
    );
  });

  it("embeds the TRIMMED value (not the raw argument) in the error message", () => {
    expect(() => legacyParseBearerJwtExp(" notatime ")).toThrow(
      'invalid argument "notatime" for "--exp" flag: invalid time format `notatime` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("rejects an out-of-range zone offset instead of silently signing a null exp/iat (CLI-1961 Codex review finding)", () => {
    // Before this fix: the calendar check never looked at the offset at all, so
    // `+99:99` passed validation, `Date.parse` returned `NaN`, and the caller signed
    // a token whose `exp`/`iat` claims serialized as JSON `null`
    // (`JSON.stringify(NaN) === "null"`) instead of failing the command — verified
    // against the real binary, which rejects this exact input during flag parsing.
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:00:00+99:99")).toThrow(
      'invalid argument "2030-01-01T00:00:00+99:99" for "--exp" flag: invalid time format `2030-01-01T00:00:00+99:99` must be one of: `2006-01-02T15:04:05Z07:00`',
    );
  });

  it("tolerates a 24-hour/60-minute offset the same way Go's time.Parse does (`>` not `>=`)", () => {
    // Go's own comment (`time/format.go:1267-1269`): "The range test use > rather
    // than >=, as some people do write offsets of 24 hours or 60 minutes" — verified
    // directly against the Go standard library.
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00+24:00")).toBe(
      legacyParseBearerJwtExp("2030-01-01T00:00:00Z") - 24 * 60 * 60,
    );
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00+00:60")).toBe(
      legacyParseBearerJwtExp("2030-01-01T00:00:00Z") - 60 * 60,
    );
  });

  it("rejects an offset that overflows even Go's 24-hour/60-minute tolerance", () => {
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:00:00+25:00")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:00:00+00:61")).toThrow(
      '"--exp" flag: invalid time format',
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

  it("preserves sub-second precision instead of flooring it away (CLI-1961)", () => {
    // Flooring here (this port's previous behavior) would silently discard the 0.5s
    // fraction before it ever reaches `legacyBuildBearerJwtClaims`'s final truncation.
    expect(legacyParseBearerJwtValidFor("1.5s")).toBe(1.5);
  });

  it("rejects a malformed value with pflag's exact wrapped message", () => {
    expect(() => legacyParseBearerJwtValidFor("xyz")).toThrow(
      'invalid argument "xyz" for "--valid-for" flag: time: invalid duration "xyz"',
    );
  });

  it("does NOT trim surrounding whitespace, unlike --exp (pflag's duration Value.Set has no TrimSpace)", () => {
    expect(() => legacyParseBearerJwtValidFor(" 30m ")).toThrow(
      'invalid argument " 30m " for "--valid-for" flag: time: invalid duration " 30m "',
    );
  });
});

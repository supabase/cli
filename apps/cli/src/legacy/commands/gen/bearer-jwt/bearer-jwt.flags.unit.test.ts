import { describe, expect, it } from "vitest";
import {
  legacyAddSecondsAndFloor,
  legacyParseBearerJwtExp,
  legacyParseBearerJwtValidFor,
} from "./bearer-jwt.flags.ts";

describe("legacyParseBearerJwtExp", () => {
  it("parses a UTC RFC3339 timestamp to Unix seconds", () => {
    expect(legacyParseBearerJwtExp("2020-01-01T00:00:00Z")).toEqual({
      wholeSeconds: 1_577_836_800,
      nanos: 0,
    });
  });

  it("honors a non-zero numeric offset", () => {
    // "+05:00" means local wall-clock time is 5 hours AHEAD of UTC, so the same wall
    // time is an EARLIER instant than at "Z" — verified against the real binary
    // (CLI-1961): 2030-01-01T00:00:00+05:00 -> exp 1893438000, ...Z -> exp 1893456000.
    const withOffset = legacyParseBearerJwtExp("2030-01-01T00:00:00+05:00");
    const atZ = legacyParseBearerJwtExp("2030-01-01T00:00:00Z");
    expect(withOffset).toEqual({ wholeSeconds: atZ.wholeSeconds - 5 * 60 * 60, nanos: 0 });
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
    expect(legacyParseBearerJwtExp("2000-02-29T00:00:00Z")).toEqual({
      wholeSeconds: 951782400,
      nanos: 0,
    });
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
    expect(legacyParseBearerJwtExp(" 2030-01-01T00:00:00Z ")).toEqual(
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
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00+24:00")).toEqual({
      wholeSeconds: legacyParseBearerJwtExp("2030-01-01T00:00:00Z").wholeSeconds - 24 * 60 * 60,
      nanos: 0,
    });
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00+00:60")).toEqual({
      wholeSeconds: legacyParseBearerJwtExp("2030-01-01T00:00:00Z").wholeSeconds - 60 * 60,
      nanos: 0,
    });
  });

  it("rejects an offset that overflows even Go's 24-hour/60-minute tolerance", () => {
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:00:00+25:00")).toThrow(
      '"--exp" flag: invalid time format',
    );
    expect(() => legacyParseBearerJwtExp("2030-01-01T00:00:00+00:61")).toThrow(
      '"--exp" flag: invalid time format',
    );
  });

  it("preserves fractional seconds instead of dropping them during parsing (CLI-1961 Codex review finding)", () => {
    // Go's `time.Parse(time.RFC3339, ...)` accepts (and preserves at full precision)
    // fractional seconds even though `time.RFC3339`'s own layout has no fractional
    // directive — verified against the Go standard library. Dropping the `.9` here
    // (this port's previous behavior) would produce nanos `0` instead of `900_000_000`.
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00.9Z")).toEqual({
      wholeSeconds: 1_893_456_000,
      nanos: 900_000_000,
    });
  });

  it("preserves a fractional offset the same way for a non-UTC zone", () => {
    const withFraction = legacyParseBearerJwtExp("2030-01-01T00:00:00.5+05:00");
    const atZ = legacyParseBearerJwtExp("2030-01-01T00:00:00Z");
    expect(withFraction).toEqual({
      wholeSeconds: atZ.wholeSeconds - 5 * 60 * 60,
      nanos: 500_000_000,
    });
  });

  it("preserves a near-second nanosecond fraction as an exact integer instead of rounding it into the next second (CLI-1961 Codex review finding)", () => {
    // Verified directly: a naive `wholeSeconds + Number('0.999999999')` float addition
    // rounds UP to the exact integer `wholeSeconds + 1` in plain JS float arithmetic —
    // Go's `time.Time` keeps the nanoseconds in a separate integer field and
    // `jwt.NewNumericDate`'s `Truncate` floors DOWN, so the true parsed instant must
    // report `nanos: 999_999_999` here, not silently become `wholeSeconds + 1, nanos: 0`.
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00.999999999Z")).toEqual({
      wholeSeconds: 1_893_456_000,
      nanos: 999_999_999,
    });
  });

  it("truncates (not rounds) fractional digits beyond nanosecond precision, matching Go's time.Parse", () => {
    // Verified directly against the Go standard library: `.9999999995` (10 digits)
    // parses to nanosecond `999999999`, not a rounded-up `1000000000` that would carry
    // into the next second.
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00.9999999995Z")).toEqual({
      wholeSeconds: 1_893_456_000,
      nanos: 999_999_999,
    });
  });

  it("accepts a comma as the fractional-seconds separator, matching Go's time.Parse (CLI-1961 Codex review finding)", () => {
    // Verified directly against the Go standard library: `time.Parse(time.RFC3339,
    // "2030-01-01T00:00:00,5Z")` succeeds with the same nanosecond result as the `.5`
    // spelling — Go's parser accepts either `.` or `,` as the fractional-seconds
    // separator for any layout element.
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00,5Z")).toEqual(
      legacyParseBearerJwtExp("2030-01-01T00:00:00.5Z"),
    );
  });

  it("accepts a comma fraction alongside a non-UTC zone offset too", () => {
    expect(legacyParseBearerJwtExp("2030-01-01T00:00:00,5+05:00")).toEqual(
      legacyParseBearerJwtExp("2030-01-01T00:00:00.5+05:00"),
    );
  });

  it("parses an early (0000-0099) RFC3339 year literally instead of applying JS's two-digit-year remapping (CLI-1961 Codex review finding)", () => {
    // Verified directly against the Go standard library: `0001-01-01T00:00:00Z` parses
    // to Go year 1, Unix `-62135596800` — `Date.UTC`/`new Date(...)`'s legacy
    // two-digit-year special case (year `1` silently becomes `1901`) does NOT apply
    // here, since this is a genuine 4-digit RFC3339 year, not a 2-digit shorthand.
    expect(legacyParseBearerJwtExp("0001-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -62_135_596_800,
      nanos: 0,
    });
    expect(legacyParseBearerJwtExp("0099-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -59_042_995_200,
      nanos: 0,
    });
    expect(legacyParseBearerJwtExp("0000-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -62_167_219_200,
      nanos: 0,
    });
  });

  it("still parses years at and above 0100 the same way as before (no regression from the year-remapping fix)", () => {
    expect(legacyParseBearerJwtExp("0100-01-01T00:00:00Z")).toEqual({
      wholeSeconds: -59_011_459_200,
      nanos: 0,
    });
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

describe("legacyAddSecondsAndFloor", () => {
  it("adds a whole-second delta with no carry", () => {
    expect(legacyAddSecondsAndFloor({ wholeSeconds: 100, nanos: 0 }, 5)).toBe(105);
  });

  it("carries into the next second when nanos overflow 1e9", () => {
    // Mirrors the CLI-1961 Codex review finding (`--exp` omitted, sub-second
    // `--valid-for`): a `now` of `X.900` plus a `0.2s` delta must land in the NEXT
    // second (`X + 1`), not stay in the current one.
    expect(legacyAddSecondsAndFloor({ wholeSeconds: 100, nanos: 900_000_000 }, 0.2)).toBe(101);
  });

  it("borrows from the previous second when the combined nanos go negative", () => {
    expect(legacyAddSecondsAndFloor({ wholeSeconds: 100, nanos: 200_000_000 }, -0.5)).toBe(99);
  });

  it("never rounds an epoch-scale whole-second count up via float addition (CLI-1961 Codex review finding)", () => {
    // The exact regression this helper exists to prevent: naive
    // `wholeSeconds + fraction` float addition at epoch scale rounds a near-second
    // fraction UP into the next integer.
    expect(legacyAddSecondsAndFloor({ wholeSeconds: 1_893_456_000, nanos: 999_999_999 }, 0)).toBe(
      1_893_456_000,
    );
  });
});

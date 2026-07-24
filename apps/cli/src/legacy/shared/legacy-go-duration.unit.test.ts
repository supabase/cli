import { describe, expect, it } from "vitest";

import { legacyFormatGoDuration, legacyParseGoDuration } from "./legacy-go-duration.ts";

describe("legacyParseGoDuration", () => {
  it("parses a single unit", () => {
    expect(legacyParseGoDuration("5s")).toBe(5_000_000_000);
    expect(legacyParseGoDuration("300ms")).toBe(300_000_000);
    expect(legacyParseGoDuration("1h")).toBe(3_600_000_000_000);
  });

  it("parses multiple units concatenated", () => {
    expect(legacyParseGoDuration("1h30m")).toBe(5_400_000_000_000);
  });

  it("parses a fractional value", () => {
    expect(legacyParseGoDuration("1.5s")).toBe(1_500_000_000);
  });

  it("parses a signed value", () => {
    expect(legacyParseGoDuration("-5s")).toBe(-5_000_000_000);
    expect(legacyParseGoDuration("+5s")).toBe(5_000_000_000);
  });

  it('treats a bare "0" as zero regardless of sign', () => {
    expect(legacyParseGoDuration("0")).toBe(0);
  });

  it("rejects an empty string", () => {
    expect(() => legacyParseGoDuration("")).toThrow('time: invalid duration ""');
  });

  // Task 1: a unit with no preceding digit ("s", "m", ...) used to read zero
  // digits, skip the "missing unit" guard (since `s` was still non-empty),
  // and silently match the unit anyway — returning 0 instead of erroring like
  // Go's real `time.ParseDuration`.
  it.each(["s", "m", "h", "ms", "us", "µs", "ns"])(
    'rejects a bare unit with no preceding digit ("%s")',
    (input) => {
      expect(() => legacyParseGoDuration(input)).toThrow(`time: invalid duration "${input}"`);
    },
  );

  it('rejects a bare unit following a valid unit ("1hs")', () => {
    expect(() => legacyParseGoDuration("1hs")).toThrow('time: invalid duration "1hs"');
  });

  it('rejects a negative bare unit ("-s")', () => {
    expect(() => legacyParseGoDuration("-s")).toThrow('time: invalid duration "-s"');
  });

  // Go's `pre`/`post` guard: a lone "." with no digits on either side is
  // still invalid, even though "." alone passes the leading `[0-9.]` check
  // (it's the first character of a valid fraction like ".5s").
  it.each([".s", ".", "-.", "+.", ".h"])('rejects a lone "." with no digits ("%s")', (input) => {
    expect(() => legacyParseGoDuration(input)).toThrow(`time: invalid duration "${input}"`);
  });

  it('accepts a fraction-only value with no leading digit (".5s")', () => {
    expect(legacyParseGoDuration(".5s")).toBe(500_000_000);
  });

  it("rejects a number with no unit", () => {
    expect(() => legacyParseGoDuration("5")).toThrow('time: missing unit in duration "5"');
  });

  it("rejects an unknown unit", () => {
    expect(() => legacyParseGoDuration("5x")).toThrow('time: unknown unit in duration "5x"');
  });

  // Go converts the fractional remainder via a float64->uint64 conversion,
  // which truncates toward zero rather than rounding — `"0.5ns"` must become
  // `0`, not `1`.
  it('truncates a sub-nanosecond fraction instead of rounding ("0.5ns")', () => {
    expect(legacyParseGoDuration("0.5ns")).toBe(0);
  });

  it('truncates a sub-nanosecond fraction instead of rounding ("1.9ns")', () => {
    expect(legacyParseGoDuration("1.9ns")).toBe(1);
  });

  // Go's `time.Duration` is bounded by `math.MaxInt64` nanoseconds
  // (~292.47 years); `time.ParseDuration` rejects any value whose
  // accumulated nanosecond count would exceed it.
  it('rejects a duration that overflows math.MaxInt64 nanoseconds ("2562048h")', () => {
    expect(() => legacyParseGoDuration("2562048h")).toThrow('time: invalid duration "2562048h"');
  });

  it("accepts Go's actual maximum parseable duration without overflowing", () => {
    expect(() => legacyParseGoDuration("2562047h47m16.854775807s")).not.toThrow();
  });

  // Regression test: an earlier fix's overflow bound was `Number(9223372036854775807n)`,
  // which rounds UP to `9223372036854776000` — 193 past the true `math.MaxInt64`. That let
  // this exact value (`2^63`, one nanosecond past Go's true ceiling) silently pass instead of
  // being rejected like Go's real `time.ParseDuration` rejects it.
  it('rejects a duration exactly 1ns past Go\'s true math.MaxInt64 ceiling ("9223372036854775808ns")', () => {
    expect(() => legacyParseGoDuration("9223372036854775808ns")).toThrow(
      'time: invalid duration "9223372036854775808ns"',
    );
  });

  it("accepts a duration exactly at Go's true math.MaxInt64 ceiling in nanoseconds", () => {
    expect(() => legacyParseGoDuration("9223372036854775807ns")).not.toThrow();
  });
});

describe("legacyFormatGoDuration", () => {
  it('formats zero as "0s"', () => {
    expect(legacyFormatGoDuration(0)).toBe("0s");
  });

  it("formats whole hours/minutes/seconds", () => {
    expect(legacyFormatGoDuration(3_600_000_000_000)).toBe("1h0m0s");
  });

  it("normalizes 90s to 1m30s", () => {
    expect(legacyFormatGoDuration(90_000_000_000)).toBe("1m30s");
  });

  it("formats a sub-second fraction", () => {
    expect(legacyFormatGoDuration(1_500_000_000)).toBe("1.5s");
  });

  it("round-trips through legacyParseGoDuration", () => {
    expect(legacyFormatGoDuration(legacyParseGoDuration("1h"))).toBe("1h0m0s");
    expect(legacyFormatGoDuration(legacyParseGoDuration("90s"))).toBe("1m30s");
  });

  // A sub-second remainder must still be included when minutes/hours are
  // present, matching Go's `Duration.String()`, which computes the
  // fractional-seconds string from the FULL nanosecond count before peeling
  // off minutes/hours — not just when seconds is the only component.
  it("includes a sub-second fraction alongside minutes", () => {
    expect(legacyFormatGoDuration(legacyParseGoDuration("1m0.5s"))).toBe("1m0.5s");
  });

  it("includes a sub-second fraction alongside hours", () => {
    expect(legacyFormatGoDuration(legacyParseGoDuration("1h0.5s"))).toBe("1h0m0.5s");
  });

  it("includes a sub-second fraction alongside hours and minutes", () => {
    expect(legacyFormatGoDuration(legacyParseGoDuration("1h1m0.5s"))).toBe("1h1m0.5s");
  });
});

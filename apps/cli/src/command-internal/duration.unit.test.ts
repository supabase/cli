import { describe, expect, it } from "vitest";

import { formatDuration, parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  it("parses a single unit", () => {
    expect(parseDuration("5s")).toBe(5_000_000_000);
    expect(parseDuration("300ms")).toBe(300_000_000);
    expect(parseDuration("1h")).toBe(3_600_000_000_000);
  });

  it("parses multiple units concatenated", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000_000_000);
  });

  it("parses a fractional value", () => {
    expect(parseDuration("1.5s")).toBe(1_500_000_000);
  });

  it("parses a signed value", () => {
    expect(parseDuration("-5s")).toBe(-5_000_000_000);
    expect(parseDuration("+5s")).toBe(5_000_000_000);
  });

  it('treats a bare "0" as zero regardless of sign', () => {
    expect(parseDuration("0")).toBe(0);
  });

  it("rejects an empty string", () => {
    expect(() => parseDuration("")).toThrow('time: invalid duration ""');
  });

  it.each(["s", "m", "h", "ms", "us", "µs", "μs", "ns"])(
    'rejects a bare unit with no preceding digit ("%s")',
    (input) => {
      expect(() => parseDuration(input)).toThrow(`time: invalid duration "${input}"`);
    },
  );

  it.each(["us", "µs", "μs"])('accepts every microsecond unit spelling ("1%s")', (unit) => {
    expect(parseDuration(`1${unit}`)).toBe(1_000);
  });

  it('rejects a bare unit following a valid unit ("1hs")', () => {
    expect(() => parseDuration("1hs")).toThrow('time: invalid duration "1hs"');
  });

  it('rejects a negative bare unit ("-s")', () => {
    expect(() => parseDuration("-s")).toThrow('time: invalid duration "-s"');
  });

  it.each([".s", ".", "-.", "+.", ".h"])('rejects a lone "." with no digits ("%s")', (input) => {
    expect(() => parseDuration(input)).toThrow(`time: invalid duration "${input}"`);
  });

  it('accepts a fraction-only value with no leading digit (".5s")', () => {
    expect(parseDuration(".5s")).toBe(500_000_000);
  });

  it("rejects a number with no unit", () => {
    expect(() => parseDuration("5")).toThrow('time: missing unit in duration "5"');
  });

  it("rejects an unknown unit", () => {
    expect(() => parseDuration("5x")).toThrow('time: unknown unit in duration "5x"');
  });

  it('truncates a sub-nanosecond fraction instead of rounding ("0.5ns")', () => {
    expect(parseDuration("0.5ns")).toBe(0);
  });

  it('truncates a sub-nanosecond fraction instead of rounding ("1.9ns")', () => {
    expect(parseDuration("1.9ns")).toBe(1);
  });

  it('rounds a long fractional remainder up ("0.999999999999999999s")', () => {
    expect(parseDuration("0.999999999999999999s")).toBe(1_000_000_000);
  });

  it('rejects a duration that overflows math.MaxInt64 nanoseconds ("2562048h")', () => {
    expect(() => parseDuration("2562048h")).toThrow('time: invalid duration "2562048h"');
  });

  it("accepts the maximum parseable duration without overflowing", () => {
    expect(() => parseDuration("2562047h47m16.854775807s")).not.toThrow();
  });

  it('rejects a duration exactly 1ns past the int64 maximum ("9223372036854775808ns")', () => {
    expect(() => parseDuration("9223372036854775808ns")).toThrow(
      'time: invalid duration "9223372036854775808ns"',
    );
  });

  it("accepts a duration exactly at the int64 maximum in nanoseconds", () => {
    expect(() => parseDuration("9223372036854775807ns")).not.toThrow();
  });

  it("accepts the minimum representable negative duration (int64 minimum ns)", () => {
    expect(parseDuration("-9223372036854775808ns")).toBe(-9223372036854775808);
  });

  it("accepts the equivalent hours/minutes/seconds form of math.MinInt64 ns", () => {
    expect(parseDuration("-2562047h47m16.854775808s")).toBe(-9223372036854775808);
  });

  it("rejects a duration 1ns past math.MinInt64", () => {
    expect(() => parseDuration("-9223372036854775809ns")).toThrow(
      'time: invalid duration "-9223372036854775809ns"',
    );
  });
});

describe("formatDuration", () => {
  it('formats zero as "0s"', () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats whole hours/minutes/seconds", () => {
    expect(formatDuration(3_600_000_000_000)).toBe("1h0m0s");
  });

  it("normalizes 90s to 1m30s", () => {
    expect(formatDuration(90_000_000_000)).toBe("1m30s");
  });

  it("formats a sub-second fraction", () => {
    expect(formatDuration(1_500_000_000)).toBe("1.5s");
  });

  it("round-trips through parseDuration", () => {
    expect(formatDuration(parseDuration("1h"))).toBe("1h0m0s");
    expect(formatDuration(parseDuration("90s"))).toBe("1m30s");
  });

  it("includes a sub-second fraction alongside minutes", () => {
    expect(formatDuration(parseDuration("1m0.5s"))).toBe("1m0.5s");
  });

  it("includes a sub-second fraction alongside hours", () => {
    expect(formatDuration(parseDuration("1h0.5s"))).toBe("1h0m0.5s");
  });

  it("includes a sub-second fraction alongside hours and minutes", () => {
    expect(formatDuration(parseDuration("1h1m0.5s"))).toBe("1h1m0.5s");
  });
});

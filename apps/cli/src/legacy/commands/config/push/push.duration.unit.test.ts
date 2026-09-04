/**
 * Unit tests for push.duration.ts.
 */

import { describe, expect, it } from "vitest";

import { legacyParseDuration } from "./push.duration.ts";

describe("legacyParseDuration", () => {
  it("parses a bare zero, with or without a unit", () => {
    expect(legacyParseDuration("0")).toBe(0);
    expect(legacyParseDuration("0s")).toBe(0);
  });

  it("parses a single-unit duration", () => {
    expect(legacyParseDuration("5s")).toBe(5_000_000_000);
    expect(legacyParseDuration("300ms")).toBe(300_000_000);
    expect(legacyParseDuration("1m")).toBe(60_000_000_000);
    expect(legacyParseDuration("1h")).toBe(3_600_000_000_000);
    expect(legacyParseDuration("42ns")).toBe(42);
  });

  it("accepts both the ASCII 'us' and the micro sign 'µs' for microseconds", () => {
    expect(legacyParseDuration("7us")).toBe(7_000);
    expect(legacyParseDuration("7µs")).toBe(7_000);
  });

  it("parses multi-component durations in descending unit order", () => {
    expect(legacyParseDuration("1m0s")).toBe(60_000_000_000);
    expect(legacyParseDuration("1h0m0s")).toBe(3_600_000_000_000);
    expect(legacyParseDuration("1h30m")).toBe(5_400_000_000_000);
  });

  it("parses a fractional component", () => {
    expect(legacyParseDuration("1.5s")).toBe(1_500_000_000);
  });

  it("parses a negative duration, and treats a leading '+' as a no-op", () => {
    expect(legacyParseDuration("-5s")).toBe(-5_000_000_000);
    expect(legacyParseDuration("+5s")).toBe(5_000_000_000);
  });

  it("throws on an empty string", () => {
    expect(() => legacyParseDuration("")).toThrow(/invalid duration/);
  });

  it("throws when a numeric component has no unit", () => {
    expect(() => legacyParseDuration("5")).toThrow(/missing unit/);
  });

  it("throws on an unrecognized unit", () => {
    expect(() => legacyParseDuration("5d")).toThrow(/unknown unit/);
  });
});

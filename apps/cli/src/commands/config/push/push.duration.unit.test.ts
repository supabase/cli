/**
 * Unit tests for push.duration.ts.
 */

import { describe, expect, it } from "vitest";

import { parseDuration } from "./push.duration.ts";

describe("parseDuration", () => {
  it("parses a bare zero, with or without a unit", () => {
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("0s")).toBe(0);
  });

  it("parses a single-unit duration", () => {
    expect(parseDuration("5s")).toBe(5_000_000_000);
    expect(parseDuration("300ms")).toBe(300_000_000);
    expect(parseDuration("1m")).toBe(60_000_000_000);
    expect(parseDuration("1h")).toBe(3_600_000_000_000);
    expect(parseDuration("42ns")).toBe(42);
  });

  it("accepts both the ASCII 'us' and the micro sign 'µs' for microseconds", () => {
    expect(parseDuration("7us")).toBe(7_000);
    expect(parseDuration("7µs")).toBe(7_000);
  });

  it("parses multi-component durations in descending unit order", () => {
    expect(parseDuration("1m0s")).toBe(60_000_000_000);
    expect(parseDuration("1h0m0s")).toBe(3_600_000_000_000);
    expect(parseDuration("1h30m")).toBe(5_400_000_000_000);
  });

  it("parses a fractional component", () => {
    expect(parseDuration("1.5s")).toBe(1_500_000_000);
  });

  it("parses a negative duration, and treats a leading '+' as a no-op", () => {
    expect(parseDuration("-5s")).toBe(-5_000_000_000);
    expect(parseDuration("+5s")).toBe(5_000_000_000);
  });

  it("throws on an empty string", () => {
    expect(() => parseDuration("")).toThrow(/invalid duration/);
  });

  it("throws when a numeric component has no unit", () => {
    expect(() => parseDuration("5")).toThrow(/missing unit/);
  });

  it("throws on an unrecognized unit", () => {
    expect(() => parseDuration("5d")).toThrow(/unknown unit/);
  });

  it("throws on a digit-less (unit-only) component, rather than parsing it as zero", () => {
    expect(() => parseDuration("s")).toThrow(/invalid duration/);
    expect(() => parseDuration("ms")).toThrow(/invalid duration/);
    expect(() => parseDuration("h")).toThrow(/invalid duration/);
  });

  it("accepts a decimal-only component (a digit after the point still counts)", () => {
    expect(parseDuration(".5s")).toBe(500_000_000);
  });

  it("throws when one component of an otherwise-valid duration is digit-less", () => {
    expect(() => parseDuration("1hm")).toThrow(/invalid duration/);
    expect(() => parseDuration("1h0m0s0ms")).not.toThrow();
    expect(() => parseDuration("5sms")).toThrow(/invalid duration/);
  });
});

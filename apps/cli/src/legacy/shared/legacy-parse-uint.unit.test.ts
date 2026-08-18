import { describe, expect, it } from "vitest";

import { legacyIsValidBase0Int64, legacyParseUintBase0 } from "./legacy-parse-uint.ts";

// Every expectation in this file is ground truth captured from go1.26:
// `strconv.ParseUint(s, 0, 64)` — the exact call pflag makes for a `UintVarP`
// flag (`uintValue.Set`, `pflag/uint.go`).
describe("legacyParseUintBase0 (Go strconv.ParseUint(s, 0, 64) parity)", () => {
  it("parses plain decimal", () => {
    expect(legacyParseUintBase0("0")).toEqual({ value: 0 });
    expect(legacyParseUintBase0("1")).toEqual({ value: 1 });
    expect(legacyParseUintBase0("42")).toEqual({ value: 42 });
  });

  it("rejects every sign prefix — including -0, whose numeric normalization (negative zero) passes a `value < 0` check", () => {
    expect(legacyParseUintBase0("-0")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("-01")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("-1")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("+1")).toEqual({ cause: "invalid syntax" });
  });

  it("parses Go's base-0 prefix forms: hex, octal (bare leading zero!), binary", () => {
    expect(legacyParseUintBase0("0x10")).toEqual({ value: 16 });
    expect(legacyParseUintBase0("0X10")).toEqual({ value: 16 });
    expect(legacyParseUintBase0("0o10")).toEqual({ value: 8 });
    expect(legacyParseUintBase0("010")).toEqual({ value: 8 });
    expect(legacyParseUintBase0("00")).toEqual({ value: 0 });
    expect(legacyParseUintBase0("0b10")).toEqual({ value: 2 });
  });

  it("rejects out-of-base digits (09 is an octal syntax error) and bare prefixes", () => {
    expect(legacyParseUintBase0("09")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("0x")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("0xg")).toEqual({ cause: "invalid syntax" });
  });

  it("accepts underscores between digits or after a base prefix, rejecting misplaced ones", () => {
    expect(legacyParseUintBase0("1_0")).toEqual({ value: 10 });
    expect(legacyParseUintBase0("0x_10")).toEqual({ value: 16 });
    expect(legacyParseUintBase0("_1")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("1_")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("1__0")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("0x_")).toEqual({ cause: "invalid syntax" });
  });

  it("rejects non-numeric junk: floats, words, whitespace, empty, non-ASCII digits", () => {
    expect(legacyParseUintBase0("3.5")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("abc")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0(" 1")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("1 ")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("")).toEqual({ cause: "invalid syntax" });
    expect(legacyParseUintBase0("０")).toEqual({ cause: "invalid syntax" }); // fullwidth ０
  });

  it("reports uint64 overflow as `value out of range`, accepting max uint64", () => {
    expect(legacyParseUintBase0("18446744073709551616")).toEqual({ cause: "value out of range" });
    expect(legacyParseUintBase0("0x10000000000000000")).toEqual({ cause: "value out of range" });
    // Max uint64 parses (the Number conversion is lossy up there — documented
    // residual in legacy-parse-uint.ts — but the accept/reject verdict matches Go).
    expect(legacyParseUintBase0("18446744073709551615")).toEqual({
      value: Number(18446744073709551615n),
    });
  });
});

// Every expectation in this file is ground truth captured from go1.26:
// `strconv.ParseInt(s, 0, 64)` — the exact call pflag makes for an
// `Int64VarP` flag (`int64Value.Set`, `pflag/int64.go`), e.g. `backups
// restore --timestamp`.
describe("legacyIsValidBase0Int64 (Go strconv.ParseInt(s, 0, 64) parity)", () => {
  it("accepts int64's exact bounds, both signs", () => {
    expect(legacyIsValidBase0Int64("9223372036854775807")).toBe(true); // int64 max
    expect(legacyIsValidBase0Int64("-9223372036854775808")).toBe(true); // int64 min
  });

  it("rejects a magnitude one past int64's bound on each side — the asymmetric two's-complement range", () => {
    // 9223372036854775808 is a syntactically valid uint64 (well under
    // MAX_UINT64) but exceeds int64's positive bound by exactly one.
    expect(legacyIsValidBase0Int64("9223372036854775808")).toBe(false);
    // -9223372036854775809's magnitude, 9223372036854775809, exceeds int64's
    // negative-side bound (9223372036854775808) by one too.
    expect(legacyIsValidBase0Int64("-9223372036854775809")).toBe(false);
  });

  it("still enforces the uint64 ceiling for a wildly out-of-range magnitude", () => {
    expect(legacyIsValidBase0Int64("18446744073709551616")).toBe(false); // one past uint64 max
  });

  it("accepts plain decimals and Go's base-0 prefix forms, signed", () => {
    expect(legacyIsValidBase0Int64("0")).toBe(true);
    expect(legacyIsValidBase0Int64("42")).toBe(true);
    expect(legacyIsValidBase0Int64("-42")).toBe(true);
    expect(legacyIsValidBase0Int64("0x10")).toBe(true);
    expect(legacyIsValidBase0Int64("-0x10")).toBe(true);
  });

  it("rejects non-numeric junk the same way the uint64 parser does", () => {
    expect(legacyIsValidBase0Int64("bogus")).toBe(false);
    expect(legacyIsValidBase0Int64("3.5")).toBe(false);
    expect(legacyIsValidBase0Int64("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { legacyParseUintBase0 } from "./cp.parse-uint.ts";

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
    // residual in cp.parse-uint.ts — but the accept/reject verdict matches Go).
    expect(legacyParseUintBase0("18446744073709551615")).toEqual({
      value: Number(18446744073709551615n),
    });
  });
});

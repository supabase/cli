import { describe, expect, it } from "vitest";

import { parseConfigValue } from "./postgres-config.shared.ts";

describe("parseConfigValue", () => {
  it("parses signed and zero-padded digit strings as int64-range numbers", () => {
    expect(parseConfigValue("100")).toBe(100);
    expect(parseConfigValue("+7")).toBe(7);
    expect(parseConfigValue("-3")).toBe(-3);
    expect(parseConfigValue("007")).toBe(7);
  });

  it("keeps a digit string that overflows int64 as the verbatim string", () => {
    expect(parseConfigValue("99999999999999999999999999")).toBe("99999999999999999999999999");
  });

  it("straddles the int64 boundary: max fits as a number, one past it stays a string", () => {
    expect(parseConfigValue("9223372036854775807")).toBe(
      Number.parseInt("9223372036854775807", 10),
    );
    expect(parseConfigValue("9223372036854775808")).toBe("9223372036854775808");
  });

  it("matches Go's strconv.ParseBool accepted literals, case-sensitively", () => {
    for (const literal of ["t", "T", "TRUE", "true", "True"]) {
      expect(parseConfigValue(literal)).toBe(true);
    }
    for (const literal of ["f", "F", "FALSE", "false", "False"]) {
      expect(parseConfigValue(literal)).toBe(false);
    }
  });

  it("keeps case-mismatched or non-canonical bool-ish strings as plain strings", () => {
    expect(parseConfigValue("tRuE")).toBe("tRuE");
    expect(parseConfigValue("YES")).toBe("YES");
    expect(parseConfigValue("on")).toBe("on");
  });

  it("prefers the int branch over ParseBool for bare 1/0", () => {
    expect(parseConfigValue("1")).toBe(1);
    expect(parseConfigValue("0")).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { legacyGoFormatFloat } from "./legacy-go-float.ts";

describe("legacyGoFormatFloat", () => {
  it("renders fixed notation within Go's [-4, 6) decimal-exponent range", () => {
    expect(legacyGoFormatFloat(100)).toBe("100");
    expect(legacyGoFormatFloat(100000)).toBe("100000");
    expect(legacyGoFormatFloat(0.5)).toBe("0.5");
    expect(legacyGoFormatFloat(0.0001)).toBe("0.0001");
  });

  it("switches to signed exponent notation at exponent >= 6 or < -4", () => {
    expect(legacyGoFormatFloat(1000000)).toBe("1e+06");
    expect(legacyGoFormatFloat(100000000000)).toBe("1e+11");
    expect(legacyGoFormatFloat(123456789)).toBe("1.23456789e+08");
    expect(legacyGoFormatFloat(0.00001)).toBe("1e-05");
  });

  it("preserves the sign for negative exponent-notation values", () => {
    expect(legacyGoFormatFloat(-1000000)).toBe("-1e+06");
  });

  it("renders zero as a bare 0", () => {
    expect(legacyGoFormatFloat(0)).toBe("0");
  });
});

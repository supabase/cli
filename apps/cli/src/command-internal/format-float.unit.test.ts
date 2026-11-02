import { describe, expect, it } from "vitest";

import { formatGeneralFloat } from "./format-float.ts";

describe("formatGeneralFloat", () => {
  it("renders fixed notation within the [-4, 6) decimal-exponent range", () => {
    expect(formatGeneralFloat(100)).toBe("100");
    expect(formatGeneralFloat(100000)).toBe("100000");
    expect(formatGeneralFloat(0.5)).toBe("0.5");
    expect(formatGeneralFloat(0.0001)).toBe("0.0001");
  });

  it("switches to signed exponent notation at exponent >= 6 or < -4", () => {
    expect(formatGeneralFloat(1000000)).toBe("1e+06");
    expect(formatGeneralFloat(100000000000)).toBe("1e+11");
    expect(formatGeneralFloat(123456789)).toBe("1.23456789e+08");
    expect(formatGeneralFloat(0.00001)).toBe("1e-05");
  });

  it("preserves the sign for negative exponent-notation values", () => {
    expect(formatGeneralFloat(-1000000)).toBe("-1e+06");
  });

  it("renders zero as a bare 0", () => {
    expect(formatGeneralFloat(0)).toBe("0");
  });
});

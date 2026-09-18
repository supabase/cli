import { describe, expect, it } from "vitest";

import { goFormatFloat } from "./go-float.ts";

describe("goFormatFloat", () => {
  it("renders fixed notation within Go's [-4, 6) decimal-exponent range", () => {
    expect(goFormatFloat(100)).toBe("100");
    expect(goFormatFloat(100000)).toBe("100000");
    expect(goFormatFloat(0.5)).toBe("0.5");
    expect(goFormatFloat(0.0001)).toBe("0.0001");
  });

  it("switches to signed exponent notation at exponent >= 6 or < -4", () => {
    expect(goFormatFloat(1000000)).toBe("1e+06");
    expect(goFormatFloat(100000000000)).toBe("1e+11");
    expect(goFormatFloat(123456789)).toBe("1.23456789e+08");
    expect(goFormatFloat(0.00001)).toBe("1e-05");
  });

  it("preserves the sign for negative exponent-notation values", () => {
    expect(goFormatFloat(-1000000)).toBe("-1e+06");
  });

  it("renders zero as a bare 0", () => {
    expect(goFormatFloat(0)).toBe("0");
  });
});

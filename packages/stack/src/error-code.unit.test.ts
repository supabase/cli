import { describe, expect, it } from "vitest";
import { errorCode } from "./error-code.ts";

describe("errorCode", () => {
  it("reads codes only within the bounded cause chain", () => {
    const withinLimit = { cause: { cause: { code: "ECONNREFUSED" } } };
    let beyondLimit: unknown = { code: "ETIMEDOUT" };
    for (let depth = 0; depth < 8; depth += 1) beyondLimit = { cause: beyondLimit };

    expect(errorCode(withinLimit)).toBe("ECONNREFUSED");
    expect(errorCode(beyondLimit)).toBeUndefined();
  });

  it("terminates cyclic cause chains", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;

    expect(errorCode(cyclic)).toBeUndefined();
  });
});

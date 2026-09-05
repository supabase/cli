import { describe, expect, it } from "vitest";
import { isClassifiedExternalErrorTag } from "./error-actionability.ts";

describe("error actionability coverage", () => {
  it("classifies Effect CLI parser errors", () => {
    for (const tag of ["MissingOption", "MissingArgument", "InvalidValue", "UnknownSubcommand"]) {
      expect(isClassifiedExternalErrorTag(tag)).toBe(true);
    }
  });
});

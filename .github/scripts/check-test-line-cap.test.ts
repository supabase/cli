import { describe, expect, test } from "bun:test";

import { findLineCapViolations, type FileLineCounts } from "./check-test-line-cap.ts";

describe("findLineCapViolations", () => {
  test.each([
    ["new file under the cap passes", { path: "a.test.ts", baseLines: 0, headLines: 500 }, false],
    ["new file over the cap fails", { path: "a.test.ts", baseLines: 0, headLines: 1200 }, true],
    [
      "oversized file that grows fails",
      { path: "big.test.ts", baseLines: 1500, headLines: 1600 },
      true,
    ],
    [
      "oversized file left unchanged passes",
      { path: "big.test.ts", baseLines: 1500, headLines: 1500 },
      false,
    ],
    [
      "oversized file shrunk passes",
      { path: "big.test.ts", baseLines: 1500, headLines: 1400 },
      false,
    ],
    [
      "file crossing the cap from under fails",
      { path: "mid.test.ts", baseLines: 900, headLines: 1050 },
      true,
    ],
    [
      "renamed oversized file compared with its old size",
      { path: "renamed.test.ts", baseLines: 1500, headLines: 1600 },
      true,
    ],
  ] satisfies ReadonlyArray<[string, FileLineCounts, boolean]>)(
    "%s",
    (_name, file, expectViolation) => {
      const violations = findLineCapViolations([file]);
      expect(violations.length > 0).toBe(expectViolation);
    },
  );
});

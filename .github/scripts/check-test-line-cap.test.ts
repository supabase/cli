import { describe, expect, test } from "bun:test";

import {
  findLineCapViolations,
  parseNameStatusZ,
  type FileLineCounts,
} from "./check-test-line-cap.ts";

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
  ] satisfies ReadonlyArray<[string, FileLineCounts, boolean]>)(
    "%s",
    (_name, file, expectViolation) => {
      const violations = findLineCapViolations([file]);
      expect(violations.length > 0).toBe(expectViolation);
    },
  );
});

describe("parseNameStatusZ", () => {
  test("parses modified, added, renamed-with-score, and odd-path records, ignoring deletes", () => {
    const record = [
      "M",
      "a.test.ts",
      "A",
      "new.test.ts",
      "R087",
      "old-name.test.ts",
      "renamed.test.ts",
      "D",
      "removed.test.ts",
      "M",
      "spacé dir/weird name.test.ts",
    ].join("\0");

    expect(parseNameStatusZ(record)).toEqual([
      { path: "a.test.ts", basePath: "a.test.ts" },
      { path: "new.test.ts", basePath: "new.test.ts" },
      { path: "renamed.test.ts", basePath: "old-name.test.ts" },
      { path: "spacé dir/weird name.test.ts", basePath: "spacé dir/weird name.test.ts" },
    ]);
  });
});

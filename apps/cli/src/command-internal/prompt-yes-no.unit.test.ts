import { describe, expect, it } from "vitest";

import { parseYesNo } from "./prompt-yes-no.ts";

// Port of Go's `parseYesNo` (`apps/cli-go/internal/utils/console.go:84-93`).
describe("parseYesNo", () => {
  it("parses affirmative answers (case-insensitive, trimmed)", () => {
    for (const input of ["y", "Y", "yes", "YES", " Yes ", "yEs"]) {
      expect(parseYesNo(input)).toBe(true);
    }
  });

  it("parses negative answers (case-insensitive, trimmed)", () => {
    for (const input of ["n", "N", "no", "NO", " No ", "nO"]) {
      expect(parseYesNo(input)).toBe(false);
    }
  });

  it("returns undefined for unparseable or empty input", () => {
    for (const input of ["", "  ", "maybe", "yeah", "1", "true", "yep"]) {
      expect(parseYesNo(input)).toBeUndefined();
    }
  });
});

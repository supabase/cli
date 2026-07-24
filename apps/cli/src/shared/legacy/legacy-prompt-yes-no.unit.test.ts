import { describe, expect, it } from "vitest";

import { legacyParseYesNo } from "./legacy-prompt-yes-no.ts";

// Port of Go's `parseYesNo` (`apps/cli-go/internal/utils/console.go:84-93`).
describe("legacyParseYesNo", () => {
  it("parses affirmative answers (case-insensitive, trimmed)", () => {
    for (const input of ["y", "Y", "yes", "YES", " Yes ", "yEs"]) {
      expect(legacyParseYesNo(input)).toBe(true);
    }
  });

  it("parses negative answers (case-insensitive, trimmed)", () => {
    for (const input of ["n", "N", "no", "NO", " No ", "nO"]) {
      expect(legacyParseYesNo(input)).toBe(false);
    }
  });

  it("returns undefined for unparseable or empty input", () => {
    for (const input of ["", "  ", "maybe", "yeah", "1", "true", "yep"]) {
      expect(legacyParseYesNo(input)).toBeUndefined();
    }
  });
});

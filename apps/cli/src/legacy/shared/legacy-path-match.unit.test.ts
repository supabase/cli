import { describe, expect, it } from "@effect/vitest";

import { legacyPathMatch } from "./legacy-path-match.ts";

describe("legacyPathMatch", () => {
  describe("literals and wildcards", () => {
    it.each([
      ["seed.sql", "seed.sql", true],
      ["seed.sql", "seed.txt", false],
      ["*.sql", "seed.sql", true],
      ["*.sql", "seed.txt", false],
      ["seed*.sql", "seed_data.sql", true],
      ["*", "anything", true],
      ["seed?.sql", "seed1.sql", true],
      ["seed?.sql", "seed.sql", false],
    ] as const)("%s ~ %s => %s", (pattern, name, expected) => {
      expect(legacyPathMatch(pattern, name).matched).toBe(expected);
    });
  });

  describe("`*` and `?` never cross `/` (Go's non-`/` rule)", () => {
    it.each([
      ["*.sql", "sub/seed.sql", false],
      ["seed?.sql", "seed/.sql", false],
    ] as const)("%s ~ %s => %s", (pattern, name, expected) => {
      expect(legacyPathMatch(pattern, name).matched).toBe(expected);
    });
  });

  describe("character classes", () => {
    it.each([
      ["[abc].sql", "b.sql", true],
      ["[abc].sql", "d.sql", false],
      ["[0-9].sql", "5.sql", true],
      ["[0-9].sql", "x.sql", false],
      // Negation is `^` only.
      ["[^a].sql", "b.sql", true],
      ["[^a].sql", "a.sql", false],
    ] as const)("%s ~ %s => %s", (pattern, name, expected) => {
      expect(legacyPathMatch(pattern, name).matched).toBe(expected);
    });

    it("treats a leading `!` as a literal class member, NOT negation (Go parity)", () => {
      // Go's `path.Match` negates only with a leading `^`; `!` is an ordinary
      // member. So `[!a]` matches `!` and `a`, and rejects anything else.
      expect(legacyPathMatch("[!a].sql", "!.sql").matched).toBe(true);
      expect(legacyPathMatch("[!a].sql", "a.sql").matched).toBe(true);
      expect(legacyPathMatch("[!a].sql", "b.sql").matched).toBe(false);
    });
  });

  describe("escapes", () => {
    it.each([
      ["\\*.sql", "*.sql", true],
      ["\\*.sql", "x.sql", false],
      ["\\[.sql", "[.sql", true],
    ] as const)("%s ~ %s => %s", (pattern, name, expected) => {
      expect(legacyPathMatch(pattern, name).matched).toBe(expected);
    });
  });

  describe("malformed patterns report badPattern (Go's path.ErrBadPattern)", () => {
    it.each([
      "[", // unterminated class
      "[a", // unterminated class with member
      "[]", // empty class
      "[^]", // empty negated class
      "[*!#@D#", // Go's config_test.go golden case
      "a\\", // trailing escape
    ])("%s => badPattern", (pattern) => {
      const result = legacyPathMatch(pattern, "x");
      expect(result.badPattern).toBe(true);
      expect(result.matched).toBe(false);
    });

    it("does not interpret POSIX/JS-only class syntax as a regex", () => {
      // `[[:alpha:]]` is NOT a POSIX class. Go parses it as a normal class
      // `[[:alph]` (members `[ : a l p h`) followed by a literal `]`, so it
      // matches a class member char followed by `]` — never a JS `\w`-style
      // range, and never throws.
      expect(legacyPathMatch("[[:alpha:]]", "a]").matched).toBe(true);
      expect(legacyPathMatch("[[:alpha:]]", "[]").matched).toBe(true);
      expect(legacyPathMatch("[[:alpha:]]", "z]").matched).toBe(false);
      expect(legacyPathMatch("[[:alpha:]]", "a").matched).toBe(false);
    });
  });
});

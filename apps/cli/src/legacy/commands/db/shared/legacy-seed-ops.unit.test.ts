import { describe, expect, it } from "vitest";

import { legacyMatchPattern } from "./legacy-seed-ops.ts";

describe("legacyMatchPattern", () => {
  it("matches a literal filename", () => {
    expect(legacyMatchPattern("seed.sql", "seed.sql")).toBe(true);
    expect(legacyMatchPattern("seed.sql", "other.sql")).toBe(false);
  });

  it("matches `*` against any run of characters", () => {
    expect(legacyMatchPattern("*.sql", "seed.sql")).toBe(true);
    expect(legacyMatchPattern("*.sql", "0001_init.sql")).toBe(true);
    expect(legacyMatchPattern("*.sql", "seed.txt")).toBe(false);
    expect(legacyMatchPattern("seed.*", "seed.sql")).toBe(true);
  });

  it("matches `?` against exactly one character", () => {
    expect(legacyMatchPattern("seed?.sql", "seed1.sql")).toBe(true);
    expect(legacyMatchPattern("seed?.sql", "seed12.sql")).toBe(false);
    expect(legacyMatchPattern("seed?.sql", "seed.sql")).toBe(false);
  });

  it("matches character classes with ranges and negation", () => {
    expect(legacyMatchPattern("seed[0-9].sql", "seed5.sql")).toBe(true);
    expect(legacyMatchPattern("seed[0-9].sql", "seedx.sql")).toBe(false);
    expect(legacyMatchPattern("seed[!0-9].sql", "seedx.sql")).toBe(true);
    expect(legacyMatchPattern("seed[!0-9].sql", "seed5.sql")).toBe(false);
  });

  it("honors backslash escapes", () => {
    expect(legacyMatchPattern("seed\\*.sql", "seed*.sql")).toBe(true);
    expect(legacyMatchPattern("seed\\*.sql", "seedx.sql")).toBe(false);
  });

  it("collapses consecutive stars", () => {
    expect(legacyMatchPattern("**.sql", "seed.sql")).toBe(true);
  });
});

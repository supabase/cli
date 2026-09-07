/**
 * Unit tests for push.paths.ts.
 */

import type { ProjectConfig } from "@supabase/config";
import { describe, expect, it } from "vitest";

import {
  legacyComparePaths,
  legacyContainerEnabled,
  legacyIsPrefixOf,
  legacyIsRecord,
  legacyPathIn,
  legacySamePath,
  legacyValueAtPath,
} from "./push.paths.ts";

describe("legacyIsRecord", () => {
  it("accepts plain objects only", () => {
    expect(legacyIsRecord({})).toBe(true);
    expect(legacyIsRecord({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, primitives", () => {
    expect(legacyIsRecord([])).toBe(false);
    expect(legacyIsRecord(null)).toBe(false);
    expect(legacyIsRecord(undefined)).toBe(false);
    expect(legacyIsRecord("x")).toBe(false);
    expect(legacyIsRecord(1)).toBe(false);
  });
});

describe("legacyValueAtPath", () => {
  it("walks nested records", () => {
    expect(legacyValueAtPath({ a: { b: { c: 1 } } }, ["a", "b", "c"])).toBe(1);
  });

  it("returns undefined when a segment is missing or the value is not a record", () => {
    expect(legacyValueAtPath({ a: { b: 1 } }, ["a", "b", "c"])).toBeUndefined();
    expect(legacyValueAtPath({}, ["a"])).toBeUndefined();
    expect(legacyValueAtPath(undefined, ["a"])).toBeUndefined();
  });

  it("returns the root itself for an empty path", () => {
    expect(legacyValueAtPath({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe("legacySamePath", () => {
  it("compares paths segment-by-segment", () => {
    expect(legacySamePath(["a", "b"], ["a", "b"])).toBe(true);
    expect(legacySamePath(["a", "b"], ["a", "c"])).toBe(false);
    expect(legacySamePath(["a"], ["a", "b"])).toBe(false);
    expect(legacySamePath([], [])).toBe(true);
  });
});

describe("legacyIsPrefixOf", () => {
  it("matches a strict or equal prefix", () => {
    expect(legacyIsPrefixOf(["a"], ["a", "b"])).toBe(true);
    expect(legacyIsPrefixOf(["a", "b"], ["a", "b"])).toBe(true);
    expect(legacyIsPrefixOf([], ["a", "b"])).toBe(true);
  });

  it("rejects a longer or diverging candidate", () => {
    expect(legacyIsPrefixOf(["a", "b"], ["a"])).toBe(false);
    expect(legacyIsPrefixOf(["a", "c"], ["a", "b"])).toBe(false);
  });
});

describe("legacyPathIn", () => {
  it("finds an exact match in a path list", () => {
    expect(legacyPathIn(["a", "b"], [["x"], ["a", "b"]])).toBe(true);
    expect(legacyPathIn(["a", "c"], [["a", "b"]])).toBe(false);
  });
});

describe("legacyComparePaths", () => {
  it("orders lexicographically by segment", () => {
    expect(legacyComparePaths(["a"], ["b"])).toBeLessThan(0);
    expect(legacyComparePaths(["b"], ["a"])).toBeGreaterThan(0);
    expect(legacyComparePaths(["a"], ["a"])).toBe(0);
  });

  it("orders a shorter path before its own longer descendant", () => {
    expect(legacyComparePaths(["a"], ["a", "b"])).toBeLessThan(0);
    expect(legacyComparePaths(["a", "b"], ["a"])).toBeGreaterThan(0);
  });

  it("sorts a mixed path list into a stable total order", () => {
    const paths = [["storage", "vector"], ["api", "enabled"], ["auth", "site_url"], ["api"]];
    expect([...paths].sort(legacyComparePaths)).toEqual([
      ["api"],
      ["api", "enabled"],
      ["auth", "site_url"],
      ["storage", "vector"],
    ]);
  });
});

describe("legacyContainerEnabled", () => {
  it("is true when the container is present with enabled: true", () => {
    const local: ProjectConfig = { auth: { captcha: { enabled: true } } };
    expect(legacyContainerEnabled(local, ["auth", "captcha"])).toBe(true);
  });

  it("is false when the container is present with enabled: false", () => {
    const local: ProjectConfig = { auth: { captcha: { enabled: false } } };
    expect(legacyContainerEnabled(local, ["auth", "captcha"])).toBe(false);
  });

  it("is undefined when the container is absent — never coerced to false", () => {
    expect(legacyContainerEnabled({}, ["auth", "captcha"])).toBeUndefined();
    expect(legacyContainerEnabled({ auth: {} }, ["auth", "captcha"])).toBeUndefined();
  });

  it("is undefined when the container is present but `enabled` is not a boolean", () => {
    const local: ProjectConfig = { auth: { captcha: {} } };
    expect(legacyContainerEnabled(local, ["auth", "captcha"])).toBeUndefined();
  });
});

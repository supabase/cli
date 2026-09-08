/**
 * Unit tests for push.paths.ts.
 */

import type { ProjectConfig } from "@supabase/config";
import { describe, expect, it } from "vitest";

import {
  comparePaths,
  containerEnabled,
  isPrefixOf,
  isRecord,
  pathIn,
  samePath,
  valueAtPath,
} from "./push.paths.ts";

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("valueAtPath", () => {
  it("walks nested records", () => {
    expect(valueAtPath({ a: { b: { c: 1 } } }, ["a", "b", "c"])).toBe(1);
  });

  it("returns undefined when a segment is missing or the value is not a record", () => {
    expect(valueAtPath({ a: { b: 1 } }, ["a", "b", "c"])).toBeUndefined();
    expect(valueAtPath({}, ["a"])).toBeUndefined();
    expect(valueAtPath(undefined, ["a"])).toBeUndefined();
  });

  it("returns the root itself for an empty path", () => {
    expect(valueAtPath({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe("samePath", () => {
  it("compares paths segment-by-segment", () => {
    expect(samePath(["a", "b"], ["a", "b"])).toBe(true);
    expect(samePath(["a", "b"], ["a", "c"])).toBe(false);
    expect(samePath(["a"], ["a", "b"])).toBe(false);
    expect(samePath([], [])).toBe(true);
  });
});

describe("isPrefixOf", () => {
  it("matches a strict or equal prefix", () => {
    expect(isPrefixOf(["a"], ["a", "b"])).toBe(true);
    expect(isPrefixOf(["a", "b"], ["a", "b"])).toBe(true);
    expect(isPrefixOf([], ["a", "b"])).toBe(true);
  });

  it("rejects a longer or diverging candidate", () => {
    expect(isPrefixOf(["a", "b"], ["a"])).toBe(false);
    expect(isPrefixOf(["a", "c"], ["a", "b"])).toBe(false);
  });
});

describe("pathIn", () => {
  it("finds an exact match in a path list", () => {
    expect(pathIn(["a", "b"], [["x"], ["a", "b"]])).toBe(true);
    expect(pathIn(["a", "c"], [["a", "b"]])).toBe(false);
  });
});

describe("comparePaths", () => {
  it("orders lexicographically by segment", () => {
    expect(comparePaths(["a"], ["b"])).toBeLessThan(0);
    expect(comparePaths(["b"], ["a"])).toBeGreaterThan(0);
    expect(comparePaths(["a"], ["a"])).toBe(0);
  });

  it("orders a shorter path before its own longer descendant", () => {
    expect(comparePaths(["a"], ["a", "b"])).toBeLessThan(0);
    expect(comparePaths(["a", "b"], ["a"])).toBeGreaterThan(0);
  });

  it("sorts a mixed path list into a stable total order", () => {
    const paths = [["storage", "vector"], ["api", "enabled"], ["auth", "site_url"], ["api"]];
    expect([...paths].sort(comparePaths)).toEqual([
      ["api"],
      ["api", "enabled"],
      ["auth", "site_url"],
      ["storage", "vector"],
    ]);
  });
});

describe("containerEnabled", () => {
  it("is true when the container is present with enabled: true", () => {
    const local: ProjectConfig = { auth: { captcha: { enabled: true } } };
    expect(containerEnabled(local, ["auth", "captcha"])).toBe(true);
  });

  it("is false when the container is present with enabled: false", () => {
    const local: ProjectConfig = { auth: { captcha: { enabled: false } } };
    expect(containerEnabled(local, ["auth", "captcha"])).toBe(false);
  });

  it("is undefined when the container is absent — never coerced to false", () => {
    expect(containerEnabled({}, ["auth", "captcha"])).toBeUndefined();
    expect(containerEnabled({ auth: {} }, ["auth", "captcha"])).toBeUndefined();
  });

  it("is undefined when the container is present but `enabled` is not a boolean", () => {
    const local: ProjectConfig = { auth: { captcha: {} } };
    expect(containerEnabled(local, ["auth", "captcha"])).toBeUndefined();
  });
});

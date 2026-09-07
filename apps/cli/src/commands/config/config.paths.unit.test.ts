/**
 * Unit tests for config.paths.ts.
 */

import { describe, expect, it } from "vitest";

import {
  legacyConfigDeepEqualValue,
  legacyConfigDeepSetAtPath,
  legacyConfigIsDeclaredAtPath,
  legacyConfigIsRecord,
  legacyConfigPathKey,
  legacyConfigValueAtPath,
} from "./config.paths.ts";

describe("legacyConfigPathKey", () => {
  it("distinguishes a single dotted segment from two separate segments", () => {
    expect(legacyConfigPathKey(["a.b"])).not.toBe(legacyConfigPathKey(["a", "b"]));
  });
});

describe("legacyConfigIsRecord", () => {
  it("accepts plain objects only", () => {
    expect(legacyConfigIsRecord({})).toBe(true);
    expect(legacyConfigIsRecord({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, primitives", () => {
    expect(legacyConfigIsRecord([])).toBe(false);
    expect(legacyConfigIsRecord(null)).toBe(false);
    expect(legacyConfigIsRecord(undefined)).toBe(false);
    expect(legacyConfigIsRecord("x")).toBe(false);
    expect(legacyConfigIsRecord(1)).toBe(false);
  });
});

describe("legacyConfigValueAtPath", () => {
  it("walks nested records", () => {
    expect(legacyConfigValueAtPath({ a: { b: { c: 1 } } }, ["a", "b", "c"])).toBe(1);
  });

  it("returns undefined for a missing segment", () => {
    expect(legacyConfigValueAtPath({ a: { b: 1 } }, ["a", "b", "c"])).toBeUndefined();
    expect(legacyConfigValueAtPath({}, ["a"])).toBeUndefined();
  });

  it("returns undefined when the path walks through a non-record intermediate value", () => {
    expect(legacyConfigValueAtPath({ a: 1 }, ["a", "b"])).toBeUndefined();
  });

  it("returns undefined for an inherited (prototype-chain) key, not just an absent own key", () => {
    expect(legacyConfigValueAtPath({}, ["toString"])).toBeUndefined();
  });
});

describe("legacyConfigIsDeclaredAtPath", () => {
  it("is true for a key declared with an explicit undefined value", () => {
    expect(legacyConfigIsDeclaredAtPath({ a: undefined }, ["a"])).toBe(true);
    expect(legacyConfigValueAtPath({ a: undefined }, ["a"])).toBeUndefined();
  });

  it("is false for a genuinely absent key", () => {
    expect(legacyConfigIsDeclaredAtPath({}, ["a"])).toBe(false);
  });

  it("is false for an inherited (prototype-chain) key", () => {
    expect(legacyConfigIsDeclaredAtPath({}, ["toString"])).toBe(false);
  });
});

describe("legacyConfigDeepEqualValue", () => {
  it("compares nested records and arrays for equality", () => {
    expect(legacyConfigDeepEqualValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });

  it("finds nested records and arrays unequal", () => {
    expect(legacyConfigDeepEqualValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(legacyConfigDeepEqualValue([1, 2], [1, 2, 3])).toBe(false);
  });

  it("is false for objects with differing key counts", () => {
    expect(legacyConfigDeepEqualValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
});

describe("legacyConfigDeepSetAtPath", () => {
  it("does not mutate its input object", () => {
    const original = { a: { b: 1 } };
    const result = legacyConfigDeepSetAtPath(original, ["a", "b"], 2);
    expect(original).toEqual({ a: { b: 1 } });
    expect(result).toEqual({ a: { b: 2 } });
  });

  it("creates missing intermediate tables along the path", () => {
    const result = legacyConfigDeepSetAtPath({}, ["a", "b", "c"], 1);
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it("replaces the whole root when the path is empty", () => {
    expect(legacyConfigDeepSetAtPath({ a: 1 }, [], { z: 9 })).toEqual({ z: 9 });
  });

  it("discards an existing scalar at an intermediate segment and replaces it with a table", () => {
    const result = legacyConfigDeepSetAtPath({ a: 5 }, ["a", "b"], "x");
    expect(result).toEqual({ a: { b: "x" } });
  });
});

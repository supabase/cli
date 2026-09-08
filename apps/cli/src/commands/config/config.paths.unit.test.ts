/**
 * Unit tests for config.paths.ts.
 */

import { describe, expect, it } from "vitest";

import {
  configDeepEqualValue,
  configDeepSetAtPath,
  configIsDeclaredAtPath,
  configIsRecord,
  configPathKey,
  configValueAtPath,
} from "./config.paths.ts";

describe("configPathKey", () => {
  it("distinguishes a single dotted segment from two separate segments", () => {
    expect(configPathKey(["a.b"])).not.toBe(configPathKey(["a", "b"]));
  });
});

describe("configIsRecord", () => {
  it("accepts plain objects only", () => {
    expect(configIsRecord({})).toBe(true);
    expect(configIsRecord({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, primitives", () => {
    expect(configIsRecord([])).toBe(false);
    expect(configIsRecord(null)).toBe(false);
    expect(configIsRecord(undefined)).toBe(false);
    expect(configIsRecord("x")).toBe(false);
    expect(configIsRecord(1)).toBe(false);
  });
});

describe("configValueAtPath", () => {
  it("walks nested records", () => {
    expect(configValueAtPath({ a: { b: { c: 1 } } }, ["a", "b", "c"])).toBe(1);
  });

  it("returns undefined for a missing segment", () => {
    expect(configValueAtPath({ a: { b: 1 } }, ["a", "b", "c"])).toBeUndefined();
    expect(configValueAtPath({}, ["a"])).toBeUndefined();
  });

  it("returns undefined when the path walks through a non-record intermediate value", () => {
    expect(configValueAtPath({ a: 1 }, ["a", "b"])).toBeUndefined();
  });

  it("returns undefined for an inherited (prototype-chain) key, not just an absent own key", () => {
    expect(configValueAtPath({}, ["toString"])).toBeUndefined();
  });
});

describe("configIsDeclaredAtPath", () => {
  it("is true for a key declared with an explicit undefined value", () => {
    expect(configIsDeclaredAtPath({ a: undefined }, ["a"])).toBe(true);
    expect(configValueAtPath({ a: undefined }, ["a"])).toBeUndefined();
  });

  it("is false for a genuinely absent key", () => {
    expect(configIsDeclaredAtPath({}, ["a"])).toBe(false);
  });

  it("is false for an inherited (prototype-chain) key", () => {
    expect(configIsDeclaredAtPath({}, ["toString"])).toBe(false);
  });
});

describe("configDeepEqualValue", () => {
  it("compares nested records and arrays for equality", () => {
    expect(configDeepEqualValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });

  it("finds nested records and arrays unequal", () => {
    expect(configDeepEqualValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(configDeepEqualValue([1, 2], [1, 2, 3])).toBe(false);
  });

  it("is false for objects with differing key counts", () => {
    expect(configDeepEqualValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
});

describe("configDeepSetAtPath", () => {
  it("does not mutate its input object", () => {
    const original = { a: { b: 1 } };
    const result = configDeepSetAtPath(original, ["a", "b"], 2);
    expect(original).toEqual({ a: { b: 1 } });
    expect(result).toEqual({ a: { b: 2 } });
  });

  it("creates missing intermediate tables along the path", () => {
    const result = configDeepSetAtPath({}, ["a", "b", "c"], 1);
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it("replaces the whole root when the path is empty", () => {
    expect(configDeepSetAtPath({ a: 1 }, [], { z: 9 })).toEqual({ z: 9 });
  });

  it("discards an existing scalar at an intermediate segment and replaces it with a table", () => {
    const result = configDeepSetAtPath({ a: 5 }, ["a", "b"], "x");
    expect(result).toEqual({ a: { b: "x" } });
  });
});

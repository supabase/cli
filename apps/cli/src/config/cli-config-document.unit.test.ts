import { describe, expect, it } from "@effect/vitest";

import { getDocumentValue, pruneDocumentPaths, setDocumentValue } from "./cli-config-document.ts";

const withCleanPrototype = (body: () => void) => {
  try {
    body();
  } finally {
    delete (Object.prototype as Record<string, unknown>)["polluted"];
    delete (Object.prototype as Record<string, unknown>)["subject"];
  }
};

describe("config document paths", () => {
  it("writes a dotted segment under its literal key without touching Object.prototype", () => {
    withCleanPrototype(() => {
      const document: Record<string, unknown> = { template: {} };

      setDocumentValue(document, ["template", "__proto__.polluted", "subject"], "x");

      expect(document).toEqual({ template: { "__proto__.polluted": { subject: "x" } } });
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
  });

  it("creates an own __proto__ table instead of reaching the prototype", () => {
    withCleanPrototype(() => {
      const document: Record<string, unknown> = {};

      setDocumentValue(document, ["t", "__proto__", "subject"], "x");

      const table = document["t"] as Record<string, unknown>;
      expect(Object.getPrototypeOf(table)).toBe(Object.prototype);
      expect(Object.hasOwn(table, "__proto__")).toBe(true);
      expect(({} as Record<string, unknown>)["subject"]).toBeUndefined();
    });
  });

  it("replaces an inherited constructor value with an own table", () => {
    const document: Record<string, unknown> = {};

    setDocumentValue(document, ["constructor", "prototype", "polluted"], "x");

    expect(Object.hasOwn(document, "constructor")).toBe(true);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(Object.hasOwn(Object, "polluted")).toBe(false);
  });

  it("reads only own properties", () => {
    expect(getDocumentValue({}, ["__proto__", "polluted"])).toBeUndefined();
    expect(getDocumentValue({ "a.b": { c: 1 } }, ["a.b", "c"])).toBe(1);
    expect(getDocumentValue({ a: { b: { c: 1 } } }, ["a.b", "c"])).toBeUndefined();
  });

  it("prunes a leaf without walking into Object.prototype", () => {
    withCleanPrototype(() => {
      (Object.prototype as Record<string, unknown>)["polluted"] = { subject: "keep" };
      const document: Record<string, unknown> = {};

      pruneDocumentPaths(document, [["__proto__", "polluted", "subject"]], {});

      expect((Object.prototype as Record<string, unknown>)["polluted"]).toEqual({
        subject: "keep",
      });
    });
  });

  it("prunes emptied tables unless the declared document holds them", () => {
    const document: Record<string, unknown> = { a: { b: { c: 1 } }, x: { y: { z: 1 } } };

    pruneDocumentPaths(
      document,
      [
        ["a", "b", "c"],
        ["x", "y", "z"],
      ],
      { x: {} },
    );

    expect(document).toEqual({ x: {} });
  });
});

import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { compute } from "./compute.ts";

const decode = Schema.decodeUnknownSync(compute);

const computeNamePattern = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

describe("compute schema", () => {
  test("decodes a compute table with every dial set", () => {
    const every = {
      api: {
        runtime: "node",
        size: "4gb",
        exposure: "private",
        instances: 3,
        source: "packages/api",
      },
    };
    expect(decode(every)).toEqual(every);
  });

  test("accepts an exposure it does not itself recognize", () => {
    expect(decode({ api: { exposure: "internal" } })).toEqual({ api: { exposure: "internal" } });
  });

  test("rejects a non-string exposure", () => {
    expect(() => decode({ api: { exposure: true } })).toThrow();
  });

  test("defaults to an empty section when the key is absent", () => {
    expect(Schema.decodeUnknownSync(Schema.Struct({ compute }))({})).toEqual({ compute: {} });
  });

  test("drops compute names that are not DNS labels", () => {
    expect(decode({ Not_A_Label: {}, api: { runtime: "node" } })).toEqual({
      api: { runtime: "node" },
    });
  });

  test("decodes a compute table with no dials set", () => {
    expect(decode({ api: {} })).toEqual({ api: {} });
  });

  test("rejects a non-numeric instance count", () => {
    expect(() => decode({ api: { instances: "three" } })).toThrow();
  });

  test.each([
    ["a fraction", 1.5],
    ["a negative count", -1],
  ])("rejects %s as an instance count", (_label, instances) => {
    expect(() => decode({ api: { instances } })).toThrow();
  });

  test("accepts zero instances", () => {
    expect(decode({ api: { instances: 0 } })).toEqual({ api: { instances: 0 } });
  });

  test("rejects a bare value where a compute table belongs", () => {
    expect(() => decode({ api: "node" })).toThrow();
  });

  test("includes compute properties in the generated JSON schema", () => {
    const json = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(compute).schema));
    const objectSchema = json.anyOf?.find((entry: { type?: string }) => entry?.type === "object");
    const computeSchema = objectSchema?.patternProperties?.[computeNamePattern];

    expect(computeSchema?.properties?.runtime).toBeDefined();
    expect(computeSchema?.properties?.size).toBeDefined();
    expect(computeSchema?.properties?.exposure).toBeDefined();
    expect(computeSchema?.properties?.instances).toBeDefined();
    expect(computeSchema?.properties?.source).toBeDefined();
  });

  test("bounds instances as a non-negative integer in the generated JSON schema", () => {
    const json = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(compute).schema));
    const objectSchema = json.anyOf?.find((entry: { type?: string }) => entry?.type === "object");
    const computeSchema = objectSchema?.patternProperties?.[computeNamePattern];

    expect(computeSchema?.properties?.instances?.type).toBe("integer");
    expect(JSON.stringify(computeSchema?.properties?.instances)).toContain('"minimum":0');
  });
});

import { describe, expect, test } from "vitest";
import { toCliConfigJsonSchema } from "./base.ts";
import { toProjectConfigJsonSchema } from "./project-config/project-schema.ts";

type Node = Record<string, unknown>;

const at = (node: unknown, ...path: ReadonlyArray<string | number>): Node => {
  let current: unknown = node;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current as Node;
};

describe("published JSON Schema documents", () => {
  test("pattern-keyed records stay open while structs stay closed", () => {
    const cli = toCliConfigJsonSchema();
    const functions = at(cli, "properties", "functions", "anyOf", 0);
    expect(Object.keys(functions.patternProperties as Node)).toHaveLength(1);
    expect(functions).not.toHaveProperty("additionalProperties");
    expect(at(cli, "properties", "api")).toHaveProperty("additionalProperties", false);

    const project = toProjectConfigJsonSchema();
    expect(at(project, "properties", "compute")).not.toHaveProperty("additionalProperties");
  });

  test("empty bucket tables render as object or array", () => {
    const project = toProjectConfigJsonSchema();
    const buckets = at(
      project,
      "properties",
      "storage",
      "properties",
      "analytics",
      "properties",
      "buckets",
    );
    expect(buckets.additionalProperties).toEqual({
      anyOf: [{ type: "object" }, { type: "array" }],
    });
  });
});

import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { toCliConfigJsonSchema } from "./base.ts";
import { toPublishedJsonSchemaDocument } from "./json-schema-document.ts";
import { env } from "./lib/env.ts";
import { secretPathPatterns } from "./lib/secret-paths.ts";
import { toProjectConfigJsonSchema } from "./project-config/project-schema.ts";

type Node = Record<string, unknown>;

const at = (node: unknown, ...path: ReadonlyArray<string | number>): Node => {
  let current: unknown = node;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current as Node;
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectSecretPaths = (document: unknown): Array<string> => {
  const found = new Set<string>();
  const visit = (node: unknown, path: ReadonlyArray<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path);
      return;
    }
    if (!isNode(node)) return;
    if (node["x-secret"] === true) found.add(path.join("."));
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === "properties" && isNode(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, [...path, name]);
      } else if (keyword === "patternProperties" && isNode(value)) {
        for (const child of Object.values(value)) visit(child, [...path, "*"]);
      } else if (keyword === "additionalProperties") {
        visit(value, [...path, "*"]);
      } else if (keyword === "anyOf" || keyword === "oneOf" || keyword === "allOf") {
        visit(value, path);
      }
    }
  };
  visit(document, []);
  return [...found].sort();
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

  test("the CLI schema marks exactly the secret paths the schema declares", () => {
    const declared = secretPathPatterns.map((pattern) => pattern.join(".")).sort();
    expect(declared).not.toHaveLength(0);
    expect(collectSecretPaths(toCliConfigJsonSchema())).toEqual(declared);
  });

  test("the project config schema carries no secret markers", () => {
    expect(JSON.stringify(toProjectConfigJsonSchema())).not.toContain('"x-secret"');
  });

  test("custom annotations other than x-secret are not published", () => {
    const deferredSecret = toPublishedJsonSchemaDocument(
      Schema.Struct({ token: env({ secret: true }) }),
      { onExcessProperty: "error" },
    );
    expect(collectSecretPaths(deferredSecret)).toEqual(["token"]);
    expect(JSON.stringify(deferredSecret)).not.toContain("x-env-deferred");
    expect(JSON.stringify(toCliConfigJsonSchema())).not.toContain("x-env-deferred");
  });
});

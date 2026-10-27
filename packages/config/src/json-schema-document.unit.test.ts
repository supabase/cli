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

  test("migration checks publish a closed object with patterned exclusions", () => {
    const checks = at(
      toCliConfigJsonSchema(),
      "properties",
      "db",
      "properties",
      "migrations",
      "properties",
      "checks",
    );
    const rules = [
      "rls_disabled_in_public",
      "rls_enabled_no_policy",
      "policy_exists_rls_disabled",
      "security_definer_view",
      "rls_policy_always_true",
      "sensitive_columns_exposed",
      "auth_users_exposed",
      "function_search_path_mutable",
      "rls_references_user_metadata",
    ];
    expect(checks).not.toHaveProperty("allOf");
    expect(checks).toHaveProperty("additionalProperties", false);
    expect(Object.keys(at(checks, "properties")).sort()).toEqual([...rules, "exclude"].sort());
    const exclude = at(checks, "properties", "exclude");
    expect(Object.keys(at(exclude, "properties")).sort()).toEqual([...rules].sort());
    for (const rule of rules) {
      expect(at(checks, "properties", rule)).toMatchObject({
        type: "string",
        enum: ["error", "warn", "off"],
      });
      expect(at(exclude, "properties", rule)).toMatchObject({ type: "array" });
      expect(at(exclude, "properties", rule, "items").pattern).toEqual(expect.any(String));
    }
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

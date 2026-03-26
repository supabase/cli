import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { functions } from "./functions.ts";

describe("functions schema", () => {
  test("includes the legacy function properties in generated JSON schema", () => {
    const json = Schema.toJsonSchemaDocument(functions).schema;
    const normalized = JSON.parse(JSON.stringify(json));
    const recordSchema = normalized.anyOf?.find(
      (entry: { type?: string }) => entry?.type === "object",
    );
    const funcSchema = recordSchema?.patternProperties?.["^[a-zA-Z0-9_-]+$"]?.anyOf?.find(
      (entry: { type?: string }) => entry?.type === "object",
    );

    expect(funcSchema?.properties?.enabled).toBeDefined();
    expect(funcSchema?.properties?.verify_jwt).toBeDefined();
    expect(funcSchema?.properties?.import_map).toBeDefined();
    expect(funcSchema?.properties?.entrypoint).toBeDefined();
    expect(funcSchema?.properties?.static_files).toBeDefined();
  });

  test("does not expose non-legacy function env settings", () => {
    const json = Schema.toJsonSchemaDocument(functions).schema;
    const normalized = JSON.parse(JSON.stringify(json));
    const recordSchema = normalized.anyOf?.find(
      (entry: { type?: string }) => entry?.type === "object",
    );
    const funcSchema = recordSchema?.patternProperties?.["^[a-zA-Z0-9_-]+$"]?.anyOf?.find(
      (entry: { type?: string }) => entry?.type === "object",
    );

    expect(funcSchema?.properties?.env).toBeUndefined();
  });
});

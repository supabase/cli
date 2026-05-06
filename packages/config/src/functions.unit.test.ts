import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { functions } from "./functions.ts";

describe("functions schema", () => {
  test("includes function properties in generated JSON schema", () => {
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
    expect(funcSchema?.properties?.env).toBeDefined();
  });

  test("decodes per-function env references", () => {
    const decodeFunctions = Schema.decodeUnknownSync(functions);

    expect(
      decodeFunctions({
        "hello-world": {
          env: {
            OPENAI_API_KEY: "env(OPENAI_API_KEY)",
          },
        },
      }),
    ).toEqual({
      "hello-world": {
        enabled: true,
        verify_jwt: true,
        import_map: "",
        entrypoint: "",
        static_files: [],
        env: {
          OPENAI_API_KEY: "env(OPENAI_API_KEY)",
        },
      },
    });
  });
});

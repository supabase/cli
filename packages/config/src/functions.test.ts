import { describe, test, expect } from "bun:test";
import { functions } from "./functions.ts";

describe("functions schema", () => {
  test("generates correct JSON schema with env field", () => {
    const json = functions.toJSON();

    // The functions schema uses patternProperties for function names
    const funcSchema = json.patternProperties?.["^[a-zA-Z0-9_-]+$"];
    expect(funcSchema).toBeDefined();

    // The func schema should have an env property
    const envProp = funcSchema?.properties?.env;
    expect(envProp).toBeDefined();
    expect(envProp?.type).toBe("object");

    // env values should be strings
    expect(envProp?.additionalProperties?.type).toBe("string");
  });

  test("env field includes description and examples", () => {
    const json = functions.toJSON();
    const funcSchema = json.patternProperties?.["^[a-zA-Z0-9_-]+$"];
    const envProp = funcSchema?.properties?.env;

    expect(envProp?.description).toContain("environment variables");
    expect(envProp?.examples).toEqual([
      {
        STRIPE_SECRET_KEY: "env(STRIPE_SECRET_KEY)",
        API_KEY: "env(OPENAI_API_KEY)",
      },
    ]);
  });

  test("env values enforce env() pattern", () => {
    const json = functions.toJSON();
    const funcSchema = json.patternProperties?.["^[a-zA-Z0-9_-]+$"];
    const envValueSchema = funcSchema?.properties?.env?.additionalProperties;

    expect(envValueSchema?.pattern).toBe("^env\\([A-Z_][A-Z0-9_]*\\)$");
  });

  test("existing function properties are preserved", () => {
    const json = functions.toJSON();
    const funcSchema = json.patternProperties?.["^[a-zA-Z0-9_-]+$"];

    expect(funcSchema?.properties?.enabled).toBeDefined();
    expect(funcSchema?.properties?.verify_jwt).toBeDefined();
    expect(funcSchema?.properties?.import_map).toBeDefined();
    expect(funcSchema?.properties?.entrypoint).toBeDefined();
  });
});

import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { ENV_PATTERN, env, interpolateEnvReferencesAgainstSchema } from "./env.ts";

describe("env()", () => {
  test("adds env() pattern to JSON schema", () => {
    const json = Schema.toJsonSchemaDocument(env({ description: "test" })).schema;
    const normalized = JSON.parse(JSON.stringify(json));

    expect(normalized.type).toBe("string");
    expect(normalized.pattern).toBe(ENV_PATTERN);
  });

  test("does not fail when secret metadata is omitted", () => {
    const json = Schema.toJsonSchemaDocument(env()).schema;
    const normalized = JSON.parse(JSON.stringify(json));

    expect(normalized.type).toBe("string");
  });

  test("keeps the env() pattern when secret metadata is present", () => {
    const json = Schema.toJsonSchemaDocument(env({ secret: true })).schema;
    const normalized = JSON.parse(JSON.stringify(json));

    expect(normalized.pattern).toBe(ENV_PATTERN);
  });
});

describe("interpolateEnvReferencesAgainstSchema", () => {
  const schema = Schema.Struct({ project_id: Schema.String });

  test("keeps a __proto__ table name as an own key", () => {
    const document = JSON.parse('{"__proto__":{"subject":"file"},"project_id":"x"}');

    const result = interpolateEnvReferencesAgainstSchema(document, {}, schema);

    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
      subject: "file",
    });
  });
});

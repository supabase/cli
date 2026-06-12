import * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, test } from "vitest";

import { normalizeNullableJsonSchema } from "./generate.ts";

function renderOpenApiSchema(schema: Parameters<typeof JsonSchema.fromSchemaOpenApi3_0>[0]) {
  const normalized = normalizeNullableJsonSchema(JsonSchema.fromSchemaOpenApi3_0(schema).schema);
  const multiDocument = SchemaRepresentation.fromJsonSchemaMultiDocument({
    dialect: "draft-2020-12",
    definitions: {},
    schemas: [normalized],
  });
  return SchemaRepresentation.toCodeDocument(multiDocument).codes[0]!.runtime;
}

describe("generate", () => {
  test("preserves nullable formatted strings in generated schemas", () => {
    expect(renderOpenApiSchema({ type: "string", format: "email", nullable: true })).toBe(
      'Schema.Union([Schema.String.annotate({ "format": "email" }), Schema.Null])',
    );
    expect(renderOpenApiSchema({ type: "string", format: "date-time", nullable: true })).toBe(
      'Schema.Union([Schema.String.annotate({ "format": "date-time" }), Schema.Null])',
    );
  });
});

import * as Arr from "effect/Array";
import * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, test } from "vitest";

import {
  normalizeNullableJsonSchema,
  normalizeQueryParameterSchema,
  sanitizeOpenApiSchema,
} from "./generate.ts";

function renderOpenApiSchema(schema: Parameters<typeof JsonSchema.fromSchemaOpenApi3_0>[0]) {
  const normalized = normalizeNullableJsonSchema(
    JsonSchema.fromSchemaOpenApi3_0(sanitizeOpenApiSchema(schema)).schema,
  );
  const importedSchemas = SchemaRepresentation.fromJsonSchemaMultiDocument({
    dialect: "draft-2020-12",
    definitions: {},
    schemas: [normalized],
  });
  return SchemaRepresentation.toCodeDocument(
    SchemaRepresentation.toRepresentations(Arr.map(importedSchemas, (schema) => schema.ast)),
  ).codes[0]!.runtime;
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

  test("accepts booleans for string-encoded boolean query parameters", () => {
    expect(
      normalizeQueryParameterSchema(
        {
          name: "verify_jwt",
          in: "query",
          schema: { type: "string", example: true },
        },
        { type: "string" },
      ),
    ).toEqual({ anyOf: [{ type: "string" }, { type: "boolean" }] });

    expect(
      normalizeQueryParameterSchema(
        {
          name: "reveal",
          in: "query",
          description: "Boolean string, true or false",
          schema: { type: "string", example: "true" },
        },
        { type: "string" },
      ),
    ).toEqual({ anyOf: [{ type: "string" }, { type: "boolean" }] });

    expect(
      normalizeQueryParameterSchema(
        {
          name: "remove_addon",
          in: "query",
          description: "If true, also removes the custom domain add-on.",
          schema: { type: "string" },
        },
        { type: "string" },
      ),
    ).toEqual({ anyOf: [{ type: "string" }, { type: "boolean" }] });

    expect(
      normalizeQueryParameterSchema(
        {
          name: "slug",
          in: "query",
          schema: { type: "string", example: "hello-world" },
        },
        { type: "string" },
      ),
    ).toEqual({ type: "string" });
  });

  test("preserves arbitrary JSON in SSO attribute mapping defaults", () => {
    expect(
      renderOpenApiSchema({
        type: "object",
        properties: {
          default: {
            oneOf: [
              { type: "object", properties: {} },
              { type: "number" },
              { type: "string" },
              { type: "boolean" },
            ],
          },
        },
      }),
    ).toContain('"default": Schema.optionalKey(Schema.Json');
  });
});

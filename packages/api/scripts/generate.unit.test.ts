import * as Arr from "effect/Array";
import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, test } from "vitest";

import { ApiKeyResponse, V1CreateABranchOutput } from "../src/generated/contracts.ts";
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

  test("relaxes Z-only date-time patterns to accept RFC 3339 numeric offsets", () => {
    // zod's `z.string().datetime()` pattern as emitted by the Management API
    // contract: only accepts a trailing `Z`.
    const zOnlyPattern =
      "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$";

    const sanitized = sanitizeOpenApiSchema({
      type: "string",
      format: "date-time",
      pattern: zOnlyPattern,
    });

    const relaxed = new RegExp(sanitized.pattern as string);
    expect(relaxed.test("2026-08-07T12:00:00Z")).toBe(true);
    expect(relaxed.test("2026-08-07T12:00:00+00:00")).toBe(true);
    expect(relaxed.test("2026-08-07T12:00:00.123456+00:00")).toBe(true);
    expect(relaxed.test("2026-08-07T12:00:00-07:00")).toBe(true);
    expect(relaxed.test("2026-08-07T12:00:00")).toBe(false);
    expect(relaxed.test("2026-08-07 12:00:00+00:00")).toBe(false);
    expect(relaxed.test("2026-02-29T12:00:00Z")).toBe(false);

    // A pattern that already accepts numeric offsets is left untouched, and a
    // date-time string without a pattern does not gain one.
    const permissive = "^.*$";
    expect(
      sanitizeOpenApiSchema({ type: "string", format: "date-time", pattern: permissive }).pattern,
    ).toBe(permissive);
    expect(sanitizeOpenApiSchema({ type: "string", format: "date-time" }).pattern).toBeUndefined();
  });

  test("generated contracts accept both Z and numeric-offset timestamps", () => {
    const branch = {
      id: "11111111-2222-4333-8444-555555555555",
      name: "feat-x",
      project_ref: "aaaaaaaaaaaaaaaaaaaa",
      parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
      is_default: false,
      persistent: false,
      status: "MIGRATIONS_PASSED",
      with_data: false,
    };
    const apiKey = { name: "anon" };

    for (const timestamp of ["2026-08-07T12:00:00Z", "2026-08-07T12:00:00+00:00"]) {
      expect(
        Schema.decodeUnknownSync(V1CreateABranchOutput)({
          ...branch,
          created_at: timestamp,
          updated_at: timestamp,
        }),
      ).toMatchObject({ created_at: timestamp, updated_at: timestamp });
      expect(
        Schema.decodeUnknownSync(ApiKeyResponse)({
          ...apiKey,
          inserted_at: timestamp,
          updated_at: timestamp,
        }),
      ).toMatchObject({ inserted_at: timestamp, updated_at: timestamp });
    }
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

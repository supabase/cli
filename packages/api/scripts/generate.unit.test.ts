import * as Arr from "effect/Array";
import * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, test } from "vitest";

import type { OpenApiDocument, OpenApiOperation } from "./generate.ts";
import {
  extractOperations,
  normalizeNullableJsonSchema,
  normalizeQueryParameterSchema,
  operationMethodName,
  operationVersionFromPath,
  renderContracts,
  renderEffectClient,
  sanitizeOpenApiSchema,
} from "./generate.ts";

function jsonResponseOperation(
  operationId: string,
  pathParamName: string,
  responseSchema: Record<string, unknown>,
): OpenApiOperation {
  return {
    operationId,
    parameters: [{ name: pathParamName, in: "path", required: true, schema: { type: "string" } }],
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: responseSchema,
          },
        },
      },
    },
  };
}

function twoVersionFixture(): OpenApiDocument {
  return {
    openapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    paths: {
      "/v1/organizations/{slug}/members": {
        get: jsonResponseOperation("v1-list-organization-members", "slug", {
          type: "array",
          items: { type: "object", properties: {}, required: [] },
        }),
      },
      "/v1/projects/{ref}": {
        get: jsonResponseOperation("v1-get-a-project", "ref", {
          type: "object",
          properties: {},
          required: [],
        }),
      },
      "/v2/organizations/{slug}/members": {
        get: jsonResponseOperation("v2-list-organization-members", "slug", {
          type: "array",
          items: { type: "object", properties: {}, required: [] },
        }),
      },
      "/v2/projects/{ref}/config": {
        get: jsonResponseOperation("v2-get-a-project-config", "ref", {
          type: "object",
          properties: {},
          required: [],
        }),
      },
    },
  };
}

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

  test("drops the spec's Z-only pattern from date-time strings (#6115)", () => {
    expect(
      renderOpenApiSchema({
        type: "string",
        format: "date-time",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
        nullable: true,
      }),
    ).toBe('Schema.Union([Schema.String.annotate({ "format": "date-time" }), Schema.Null])');
  });

  test("drops even an offset-tolerant date-time pattern (#6115)", () => {
    // The spec's most permissive variant still rejects offset-less values and
    // the lowercase `t`/`z` RFC 3339 §5.6 allows, so no date-time pattern survives.
    const offsetTolerant =
      "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";
    expect(
      renderOpenApiSchema({ type: "string", format: "date-time", pattern: offsetTolerant }),
    ).not.toContain("isPattern");
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

  test("extractOperations derives version from the path and methodName from the operationId", () => {
    const operations = extractOperations(twoVersionFixture());

    expect(operations.map((operation) => operation.operationId)).toEqual([
      "v1-get-a-project",
      "v1-list-organization-members",
      "v2-get-a-project-config",
      "v2-list-organization-members",
    ]);
    expect(
      operations.map((operation) => ({
        version: operation.version,
        methodName: operation.methodName,
      })),
    ).toEqual([
      { version: "v1", methodName: "getAProject" },
      { version: "v1", methodName: "listOrganizationMembers" },
      { version: "v2", methodName: "getAProjectConfig" },
      { version: "v2", methodName: "listOrganizationMembers" },
    ]);

    const membersOperations = operations.filter(
      (operation) => operation.methodName === "listOrganizationMembers",
    );
    expect(membersOperations).toHaveLength(2);
    expect(membersOperations.map((operation) => operation.version)).toEqual(["v1", "v2"]);
  });

  test("operationMethodName strips a real v1 version prefix and passes unprefixed names through unchanged", () => {
    expect(operationMethodName("v1GetABranchConfig")).toBe("getABranchConfig");
    expect(operationMethodName("v1ListAllProjects")).toBe("listAllProjects");
    expect(operationMethodName("healthCheck")).toBe("healthCheck");
  });

  test("operationVersionFromPath reads the version segment from a versioned path", () => {
    expect(operationVersionFromPath("/v2/projects/{ref}/config")).toBe("v2");
  });

  test("operationVersionFromPath throws for a path with no version prefix", () => {
    expect(() => operationVersionFromPath("/health")).toThrow(
      "Expected a version-prefixed path, got /health",
    );
  });

  test("extractOperations throws when a path's version disagrees with the operationId's version prefix", () => {
    const document = {
      openapi: "3.0.0",
      paths: {
        "/v2/x": { get: jsonResponseOperation("v1-x", "x", { type: "object" }) },
      },
    };

    expect(() => extractOperations(document)).toThrow(
      'Operation "v1-x" at path "/v2/x" has operationId version "v1" that disagrees with the path-derived version "v2"',
    );
  });

  test("extractOperations throws when two operationIds camelize to the same (version, methodName) pair", () => {
    const document = {
      openapi: "3.0.0",
      paths: {
        "/v2/a": { get: jsonResponseOperation("v2-get-config", "x", { type: "object" }) },
        "/v2/b": { get: jsonResponseOperation("v2-get--config", "x", { type: "object" }) },
      },
    };

    expect(() => extractOperations(document)).toThrow(
      'Duplicate namespace method "v2.getConfig": "v2-get--config" (GET /v2/b) collides with "v2-get-config" (GET /v2/a)',
    );
  });

  test("renderEffectClient emits both version namespaces with the shared method name and a versioned executor case", () => {
    const document = twoVersionFixture();
    const operations = extractOperations(document);
    const source = renderEffectClient(operations);

    expect(source).toContain("  v1: {");
    expect(source).toContain("  v2: {");

    const v1Block = source.slice(source.indexOf("  v1: {"), source.indexOf("  v2: {"));
    const v2Block = source.slice(source.indexOf("  v2: {"));
    expect(v1Block).toContain("listOrganizationMembers: (");
    expect(v2Block).toContain("listOrganizationMembers: (");

    expect(source).toContain("api.v2.listOrganizationMembers(decoded)");
  });

  test("renderContracts includes both versioned operation names and the raw kebab operationIds", () => {
    const document = twoVersionFixture();
    const operations = extractOperations(document);
    const source = renderContracts(document, operations);

    expect(source).toContain('"v1ListOrganizationMembers": {');
    expect(source).toContain('"v2ListOrganizationMembers": {');
    expect(source).toContain('  "v1-list-organization-members": "v1ListOrganizationMembers",');
    expect(source).toContain('  "v2-list-organization-members": "v2ListOrganizationMembers",');
  });
});

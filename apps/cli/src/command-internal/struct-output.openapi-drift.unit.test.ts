import { describe, expect, it } from "vitest";
import openApiSpec from "@supabase/api/openapi.json";

import { BRANCH_RESPONSE_SHAPE } from "../commands/branches/branches.response-shape.ts";
import { ORGANIZATION_RESPONSE_SHAPE } from "../commands/orgs/orgs.response-shape.ts";
import { SSL_ENFORCEMENT_RESPONSE_SHAPE } from "../commands/ssl-enforcement/ssl-enforcement.response-shape.ts";
import { SSO_PROVIDER_RESPONSE_SHAPE } from "../commands/sso/sso.response-shape.ts";
import type { OutputShape } from "./struct-output.encoders.ts";

/**
 * Mechanical drift check for the `*.response-shape.ts` specs against the live OpenAPI schemas they
 * mirror — field-name set, `shapePtr` vs `required`, field order, and value type/kind must all
 * match, or a future spec edit silently changes `-o yaml`/`-o toml` bytes instead of failing a
 * test.
 *
 * Struct fields are named from the schema's JSON keys and declared in alphabetical order, not
 * the schema's own `properties` order, so field order here is compared against an ASCII sort of
 * `properties` keys. That assumption holds for every schema below; `KNOWN_ORDER_EXCEPTIONS`
 * records the real order for any future schema where the field-name sort diverges from a plain
 * JSON-key sort.
 */

interface JsonSchema {
  readonly type?: string;
  readonly format?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: JsonSchema;
  readonly additionalProperties?: JsonSchema | boolean;
  readonly $ref?: string;
}

interface OpenApiDocument {
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
  };
}

const openapi = openApiSpec as OpenApiDocument;
const SCHEMAS = openapi.components.schemas;

function resolveSchema(schema: JsonSchema): JsonSchema {
  if (schema.$ref === undefined) {
    return schema;
  }
  const name = schema.$ref.replace("#/components/schemas/", "");
  const resolved = SCHEMAS[name];
  if (resolved === undefined) {
    throw new Error(`unresolved $ref: ${schema.$ref}`);
  }
  return resolved;
}

interface OutputShapeField {
  readonly json: string;
  readonly type: OutputShape;
}

function structFieldsOf(spec: OutputShape): ReadonlyArray<OutputShapeField> {
  if (spec.kind !== "struct") {
    throw new Error(`expected a struct OutputShape, got "${spec.kind}"`);
  }
  return spec.fields;
}

function isPointerType(type: OutputShape): boolean {
  return type.kind === "ptr" || type.kind === "nullable";
}

function unwrapPointer(type: OutputShape): OutputShape {
  return type.kind === "ptr" || type.kind === "nullable" ? type.elem : type;
}

const KNOWN_ORDER_EXCEPTIONS: ReadonlyMap<string, ReadonlyArray<string>> = new Map();

interface DriftMismatch {
  readonly path: string;
  readonly message: string;
}

function compareFieldSet(
  fields: ReadonlyArray<OutputShapeField>,
  schema: JsonSchema,
  path: string,
): ReadonlyArray<DriftMismatch> {
  const specKeys = new Set(fields.map((field) => field.json));
  const schemaKeys = Object.keys(schema.properties ?? {});

  const mismatches: Array<DriftMismatch> = [];
  for (const key of schemaKeys) {
    if (!specKeys.has(key)) {
      mismatches.push({
        path,
        message: `field "${key}" is in the schema but missing from the spec`,
      });
    }
  }
  const schemaKeySet = new Set(schemaKeys);
  for (const key of specKeys) {
    if (!schemaKeySet.has(key)) {
      mismatches.push({
        path,
        message: `field "${key}" is in the spec but missing from the schema`,
      });
    }
  }
  return mismatches;
}

function comparePointerRequired(
  fields: ReadonlyArray<OutputShapeField>,
  schema: JsonSchema,
  path: string,
): ReadonlyArray<DriftMismatch> {
  const required = new Set(schema.required ?? []);
  const mismatches: Array<DriftMismatch> = [];
  for (const field of fields) {
    // A map field is never pointer-wrapped regardless of the schema's `required` list, so
    // this is the one field kind the shapePtr/required rule doesn't hold for.
    if (unwrapPointer(field.type).kind === "map") {
      continue;
    }
    const isRequired = required.has(field.json);
    const isPointer = isPointerType(field.type);
    if (isRequired === isPointer) {
      mismatches.push({
        path: `${path}.${field.json}`,
        message: isPointer
          ? `spec marks "${field.json}" as shapePtr, but the schema marks it required`
          : `spec does not mark "${field.json}" as shapePtr, but the schema marks it optional`,
      });
    }
  }
  return mismatches;
}

function compareValueType(
  type: OutputShape,
  schema: JsonSchema,
  path: string,
): ReadonlyArray<DriftMismatch> {
  const resolved = resolveSchema(schema);
  switch (type.kind) {
    case "any":
      return [];
    case "string":
      if (
        resolved.type !== "string" ||
        resolved.format === "date-time" ||
        resolved.format === "uuid"
      ) {
        return [
          {
            path,
            message: `expected a plain string schema, got type=${resolved.type ?? "<none>"} format=${resolved.format ?? "<none>"}`,
          },
        ];
      }
      return [];
    case "time":
      if (resolved.type !== "string" || resolved.format !== "date-time") {
        return [
          {
            path,
            message: `expected type=string format=date-time (timestamp), got type=${resolved.type ?? "<none>"} format=${resolved.format ?? "<none>"}`,
          },
        ];
      }
      return [];
    case "uuid":
      if (resolved.type !== "string" || resolved.format !== "uuid") {
        return [
          {
            path,
            message: `expected type=string format=uuid, got type=${resolved.type ?? "<none>"} format=${resolved.format ?? "<none>"}`,
          },
        ];
      }
      return [];
    case "int":
      if (resolved.type !== "integer") {
        return [{ path, message: `expected type=integer, got type=${resolved.type ?? "<none>"}` }];
      }
      return [];
    case "float":
      if (resolved.type !== "number") {
        return [{ path, message: `expected type=number, got type=${resolved.type ?? "<none>"}` }];
      }
      return [];
    case "bool":
      if (resolved.type !== "boolean") {
        return [{ path, message: `expected type=boolean, got type=${resolved.type ?? "<none>"}` }];
      }
      return [];
    case "struct":
      if (resolved.type !== "object") {
        return [{ path, message: `expected type=object, got type=${resolved.type ?? "<none>"}` }];
      }
      return [];
    case "slice": {
      if (resolved.type !== "array") {
        return [{ path, message: `expected type=array, got type=${resolved.type ?? "<none>"}` }];
      }
      if (resolved.items === undefined) {
        return [{ path, message: `expected the schema to declare "items" for the array` }];
      }
      return compareValueType(type.elem, resolved.items, `${path}[]`);
    }
    case "map": {
      const additionalProperties = resolved.additionalProperties;
      if (
        resolved.type !== "object" ||
        additionalProperties === undefined ||
        additionalProperties === false
      ) {
        return [
          {
            path,
            message: `expected type=object with additionalProperties, got type=${resolved.type ?? "<none>"}`,
          },
        ];
      }
      if (additionalProperties === true) {
        return [];
      }
      return compareValueType(type.value, additionalProperties, `${path}{}`);
    }
    case "ptr":
    case "nullable":
      return compareValueType(type.elem, schema, path);
  }
}

function compareValueTypes(
  fields: ReadonlyArray<OutputShapeField>,
  schema: JsonSchema,
  path: string,
): ReadonlyArray<DriftMismatch> {
  const mismatches: Array<DriftMismatch> = [];
  for (const field of fields) {
    const fieldSchema = schema.properties?.[field.json];
    if (fieldSchema === undefined) {
      continue;
    }
    mismatches.push(...compareValueType(field.type, fieldSchema, `${path}.${field.json}`));
  }
  return mismatches;
}

function compareFieldOrder(
  fields: ReadonlyArray<OutputShapeField>,
  schema: JsonSchema,
  schemaKey: string,
  path: string,
): ReadonlyArray<DriftMismatch> {
  const specOrder = fields.map((field) => field.json);
  const schemaOrder = Object.keys(schema.properties ?? {});
  const expectedOrder = KNOWN_ORDER_EXCEPTIONS.get(schemaKey) ?? [...schemaOrder].sort();

  if (specOrder.join(",") !== expectedOrder.join(",")) {
    return [
      {
        path,
        message: `field order mismatch: spec has [${specOrder.join(", ")}], expected [${expectedOrder.join(", ")}]`,
      },
    ];
  }
  return [];
}

/**
 * Walks a {@link OutputShape} struct spec and the corresponding OpenAPI schema in lockstep, returning
 * every mismatch found. Recurses into a struct field, and into a slice field whose element is a
 * struct, so both `saml`'s nested fields and `domains`' array elements get the same field-set,
 * pointer/required, order, and value-type checks as the top-level struct.
 */
function compareShapeToSchema(
  spec: OutputShape,
  schema: JsonSchema,
  schemaName: string,
  path: string,
): ReadonlyArray<DriftMismatch> {
  const resolved = resolveSchema(schema);
  const fields = structFieldsOf(spec);
  const schemaKey = `${schemaName}${path}`;
  const mismatches: Array<DriftMismatch> = [
    ...compareFieldSet(fields, resolved, path),
    ...comparePointerRequired(fields, resolved, path),
    ...compareFieldOrder(fields, resolved, schemaKey, path),
    ...compareValueTypes(fields, resolved, path),
  ];

  for (const field of fields) {
    const inner = unwrapPointer(field.type);
    const nestedSchema = resolved.properties?.[field.json];
    if (nestedSchema === undefined) {
      continue;
    }
    if (inner.kind === "struct") {
      mismatches.push(
        ...compareShapeToSchema(inner, nestedSchema, schemaName, `${path}.${field.json}`),
      );
      continue;
    }
    if (inner.kind === "slice") {
      const elem = unwrapPointer(inner.elem);
      if (elem.kind !== "struct") {
        continue;
      }
      const itemsSchema = resolveSchema(nestedSchema).items;
      if (itemsSchema === undefined) {
        continue;
      }
      mismatches.push(
        ...compareShapeToSchema(elem, itemsSchema, schemaName, `${path}.${field.json}[]`),
      );
    }
  }

  return mismatches;
}

interface PayloadShapeEntry {
  readonly specName: string;
  readonly spec: OutputShape;
  readonly schemaName: string;
}

const PAYLOAD_SHAPE_REGISTRY: ReadonlyArray<PayloadShapeEntry> = [
  {
    specName: "BRANCH_RESPONSE_SHAPE",
    spec: BRANCH_RESPONSE_SHAPE,
    schemaName: "BranchResponse_Output",
  },
  {
    specName: "ORGANIZATION_RESPONSE_SHAPE",
    spec: ORGANIZATION_RESPONSE_SHAPE,
    schemaName: "OrganizationResponseV1_Output",
  },
  {
    specName: "SSL_ENFORCEMENT_RESPONSE_SHAPE",
    spec: SSL_ENFORCEMENT_RESPONSE_SHAPE,
    schemaName: "SslEnforcementResponse_Output",
  },
  {
    specName: "SSO_PROVIDER_RESPONSE_SHAPE",
    spec: SSO_PROVIDER_RESPONSE_SHAPE,
    schemaName: "GetProviderResponse_Output",
  },
];

describe("response-shape specs vs the OpenAPI schema (drift check)", () => {
  it.each(PAYLOAD_SHAPE_REGISTRY)(
    "$specName matches the $schemaName schema with zero drift",
    ({ spec, schemaName }) => {
      const schema = SCHEMAS[schemaName];
      if (schema === undefined) {
        throw new Error(`missing OpenAPI schema "${schemaName}"`);
      }
      expect(compareShapeToSchema(spec, schema, schemaName, "$")).toEqual([]);
    },
  );

  it("has teeth: reports a mismatch when a field is dropped from the schema", () => {
    // A hand-mutated copy of the real SslEnforcementResponse schema with `database`
    // dropped from the nested `currentConfig` object.
    const mutatedSchema: JsonSchema = {
      type: "object",
      properties: {
        appliedSuccessfully: { type: "boolean" },
        currentConfig: { type: "object", properties: {}, required: [] },
      },
      required: ["appliedSuccessfully", "currentConfig"],
    };
    const mismatches = compareShapeToSchema(
      SSL_ENFORCEMENT_RESPONSE_SHAPE,
      mutatedSchema,
      "SslEnforcementResponse",
      "$",
    );
    expect(mismatches).not.toEqual([]);
    expect(mismatches).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("database") }),
    );
  });

  it("has teeth: reports a mismatch when a field's required-ness flips", () => {
    // A hand-mutated copy of the real BranchResponse schema with `git_branch` moved into
    // `required`, though the spec still marks it `shapePtr`.
    const mutatedSchema: JsonSchema = {
      type: "object",
      properties: {
        created_at: { type: "string" },
        deletion_scheduled_at: { type: "string" },
        git_branch: { type: "string" },
        id: { type: "string" },
        is_default: { type: "boolean" },
        latest_check_run_id: { type: "number" },
        name: { type: "string" },
        notify_url: { type: "string" },
        parent_project_ref: { type: "string" },
        persistent: { type: "boolean" },
        pr_number: { type: "integer" },
        preview_project_status: { type: "string" },
        project_ref: { type: "string" },
        review_requested_at: { type: "string" },
        status: { type: "string" },
        updated_at: { type: "string" },
        with_data: { type: "boolean" },
      },
      required: [
        "id",
        "name",
        "project_ref",
        "parent_project_ref",
        "is_default",
        "git_branch",
        "persistent",
        "status",
        "created_at",
        "updated_at",
        "with_data",
      ],
    };
    const mismatches = compareShapeToSchema(
      BRANCH_RESPONSE_SHAPE,
      mutatedSchema,
      "BranchResponse",
      "$",
    );
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        path: "$.git_branch",
        message: expect.stringContaining("shapePtr"),
      }),
    );
  });

  it("has teeth: reports a mismatch when a field's value type diverges from the schema", () => {
    // A hand-mutated copy of the real SslEnforcementResponse schema with `appliedSuccessfully`
    // retyped from boolean to string.
    const mutatedSchema: JsonSchema = {
      type: "object",
      properties: {
        appliedSuccessfully: { type: "string" },
        currentConfig: {
          type: "object",
          properties: { database: { type: "boolean" } },
          required: ["database"],
        },
      },
      required: ["appliedSuccessfully", "currentConfig"],
    };
    const mismatches = compareShapeToSchema(
      SSL_ENFORCEMENT_RESPONSE_SHAPE,
      mutatedSchema,
      "SslEnforcementResponse",
      "$",
    );
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        path: "$.appliedSuccessfully",
        message: expect.stringContaining("boolean"),
      }),
    );
  });
});

#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Arr from "effect/Array";
import * as JsonSchema from "effect/JsonSchema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type OpenApiHttpMethod = Lowercase<HttpMethod>;

type OpenApiDocument = {
  readonly openapi: string;
  readonly info?: {
    readonly title?: string;
    readonly version?: string;
  };
  readonly paths: Record<string, Partial<Record<OpenApiHttpMethod, OpenApiOperation>>>;
  readonly components?: {
    readonly schemas?: Record<string, OpenApiSchema>;
  };
};

type OpenApiOperation = {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: ReadonlyArray<OpenApiParameter>;
  readonly requestBody?: OpenApiRequestBody;
  readonly responses?: Record<string, OpenApiResponse>;
};

type OpenApiRequestBody = {
  readonly required?: boolean;
  readonly content?: Record<string, OpenApiMediaType>;
};

type OpenApiResponse = {
  readonly content?: Record<string, OpenApiMediaType>;
};

type OpenApiMediaType = {
  readonly schema?: OpenApiSchema;
};

type OpenApiParameter = {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: OpenApiSchema;
};

type OpenApiSchema = {
  [key: string]: unknown;
  readonly $ref?: string;
  readonly type?: string;
  readonly description?: string;
  readonly enum?: ReadonlyArray<unknown>;
  readonly nullable?: boolean;
  readonly deprecated?: boolean;
  readonly format?: string;
  readonly items?: OpenApiSchema;
  readonly properties?: Record<string, OpenApiSchema>;
  readonly required?: ReadonlyArray<string>;
  readonly oneOf?: ReadonlyArray<OpenApiSchema>;
  readonly anyOf?: ReadonlyArray<OpenApiSchema>;
  readonly allOf?: ReadonlyArray<OpenApiSchema>;
  readonly additionalProperties?: boolean | OpenApiSchema;
};

type ObjectShape = {
  readonly properties: Record<string, OpenApiSchema>;
  readonly required: ReadonlySet<string>;
};

type RequestBodyDefinition =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "json";
      readonly contentType: "application/json";
      readonly fields: ReadonlyArray<string>;
    }
  | {
      readonly kind: "body";
      readonly contentType:
        | "application/json"
        | "application/x-www-form-urlencoded"
        | "multipart/form-data"
        | "application/vnd.denoland.eszip";
      readonly field: "body";
    };

type ResponseDefinition =
  | {
      readonly kind: "json";
    }
  | {
      readonly kind: "text";
    }
  | {
      readonly kind: "void";
    };

type OperationDefinition = {
  readonly operationId: string;
  readonly operationName: string;
  readonly schemaBase: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly description: string;
  readonly pathParams: ReadonlyArray<string>;
  readonly queryParams: ReadonlyArray<string>;
  readonly headerParams: ReadonlyArray<string>;
  readonly requestBody: RequestBodyDefinition;
  readonly response: ResponseDefinition;
  readonly inputSchemaName: string;
  readonly outputSchemaName: string;
  readonly inputSchema: OpenApiSchema;
  readonly outputSchema?: OpenApiSchema;
};

const httpMethodOrder = ["get", "post", "put", "patch", "delete", "head"] as const;
const httpMethods: Record<OpenApiHttpMethod, HttpMethod> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const sourceSpecPath = path.join(repoRoot, "packages/api/src/generated/openapi.json");
const generatedDir = path.join(repoRoot, "packages/api/src/generated");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadSpec(): OpenApiDocument {
  const parsed = JSON.parse(readFileSync(sourceSpecPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.paths)) {
    throw new Error(`Invalid OpenAPI document at ${sourceSpecPath}`);
  }

  const paths: OpenApiDocument["paths"] = {};
  for (const [pathName, pathValue] of Object.entries(parsed.paths)) {
    if (isRecord(pathValue)) {
      paths[pathName] = pathValue;
    }
  }

  let components: OpenApiDocument["components"] | undefined;
  if (isRecord(parsed.components) && isRecord(parsed.components.schemas)) {
    const schemas: Record<string, OpenApiSchema> = {};
    for (const [name, schema] of Object.entries(parsed.components.schemas)) {
      if (isRecord(schema)) {
        schemas[name] = schema;
      }
    }
    components = { schemas };
  }

  return {
    openapi: typeof parsed.openapi === "string" ? parsed.openapi : "3.0.0",
    info: isRecord(parsed.info)
      ? {
          title: typeof parsed.info.title === "string" ? parsed.info.title : undefined,
          version: typeof parsed.info.version === "string" ? parsed.info.version : undefined,
        }
      : undefined,
    paths,
    components,
  };
}

function camelize(value: string): string {
  let out = "";
  let hadSymbol = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += hadSymbol ? value[index]!.toUpperCase() : value[index]!;
      hadSymbol = false;
    } else if (code >= 48 && code <= 57) {
      if (out.length > 0) {
        out += value[index]!;
        hadSymbol = true;
      }
    } else if (out.length > 0) {
      hadSymbol = true;
    }
  }
  return out;
}

function identifier(value: string): string {
  const camel = camelize(value);
  return camel[0] ? camel[0].toUpperCase() + camel.slice(1) : camel;
}

// OpenAPI 3.0 treats `format: "uuid"` as a hint, not validation. Without a
// concrete `pattern`, the resulting Effect schema's UUID branch has no check,
// so a 20-letter project ref matches both branches of `oneOf [project-ref, uuid]`
// unions (e.g. `branch_id_or_ref`) and validation fails at "Expected exactly one
// member to match". Add the canonical RFC 4122 pattern so the branches become
// mutually exclusive. Mirrored by an inline patch in `contracts.ts` (search
// "Patched: OpenAPI's `format: \"uuid\"`") that survives ad-hoc edits between
// regenerations.
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

function sanitizeOpenApiSchema(schema: OpenApiSchema): OpenApiSchema {
  const sanitized: OpenApiSchema = {};

  for (const [key, rawValue] of Object.entries(schema)) {
    if (key === "default" || key === "example" || key === "examples") {
      continue;
    }

    if (Array.isArray(rawValue)) {
      sanitized[key] = rawValue.map((entry) =>
        isRecord(entry) ? sanitizeOpenApiSchema(entry) : entry,
      );
      continue;
    }

    if (isRecord(rawValue)) {
      sanitized[key] = sanitizeOpenApiSchema(rawValue);
      continue;
    }

    sanitized[key] = rawValue;
  }

  if (
    sanitized.type === "string" &&
    sanitized.format === "uuid" &&
    sanitized.pattern === undefined
  ) {
    sanitized.pattern = UUID_PATTERN;
  }

  return sanitized;
}

function containsBinarySchema(schema: OpenApiSchema): boolean {
  if (schema.$ref !== undefined) {
    return false;
  }
  if (schema.type === "string" && schema.format === "binary") {
    return true;
  }
  if (schema.items && containsBinarySchema(schema.items)) {
    return true;
  }
  if (schema.properties && Object.values(schema.properties).some(containsBinarySchema)) {
    return true;
  }
  if (schema.oneOf?.some(containsBinarySchema)) {
    return true;
  }
  if (schema.anyOf?.some(containsBinarySchema)) {
    return true;
  }
  if (schema.allOf?.some(containsBinarySchema)) {
    return true;
  }
  return (
    typeof schema.additionalProperties === "object" &&
    containsBinarySchema(schema.additionalProperties)
  );
}

function replaceBinarySchemaCode(code: string): string {
  return code.replace(/Schema\.String\.annotate\(\{\s*"format":\s*"binary"\s*\}\)/g, "BinaryInput");
}

function normalizeJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonSchemaValue);
  }
  return isRecord(value) ? normalizeNullableJsonSchema(value) : value;
}

function normalizeNullableJsonSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const normalized: JsonSchema.JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    normalized[key] = normalizeJsonSchemaValue(value);
  }

  const type = normalized.type;
  if (!Array.isArray(type) || !type.includes("null")) {
    return normalized;
  }

  if (Array.isArray(normalized.enum) && normalized.enum.includes(null)) {
    return normalized;
  }

  const nonNullTypes = type.filter((entry) => entry !== "null");
  if (nonNullTypes.length === 0) {
    return { type: "null" };
  }
  if (!nonNullTypes.includes("object") && !nonNullTypes.includes("array")) {
    return normalized;
  }

  const nonNullSchema = { ...normalized };
  delete nonNullSchema.type;
  return {
    anyOf: [
      {
        ...nonNullSchema,
        type: nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes,
      },
      { type: "null" },
    ],
  };
}

function resolveSchema(document: OpenApiDocument, schema: OpenApiSchema): OpenApiSchema {
  if (schema.$ref) {
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix)) {
      throw new Error(`Unsupported schema ref: ${schema.$ref}`);
    }
    const name = schema.$ref.slice(prefix.length);
    const target = document.components?.schemas?.[name];
    if (!target) {
      throw new Error(`Missing schema ref: ${schema.$ref}`);
    }
    return resolveSchema(document, target);
  }

  if (schema.allOf && schema.allOf.length > 0) {
    const shapes = schema.allOf
      .map((member) => getObjectShape(document, member))
      .filter((shape): shape is ObjectShape => shape !== undefined);

    if (shapes.length > 0) {
      const properties: Record<string, OpenApiSchema> = {};
      const required = new Set<string>();
      for (const shape of shapes) {
        Object.assign(properties, shape.properties);
        for (const key of shape.required) {
          required.add(key);
        }
      }
      return {
        type: "object",
        properties,
        required: [...required],
        nullable: schema.nullable,
        description: schema.description,
      };
    }
  }

  return sanitizeOpenApiSchema(schema);
}

function getObjectShape(document: OpenApiDocument, schema: OpenApiSchema): ObjectShape | undefined {
  const resolved = resolveSchema(document, schema);
  if (resolved.type === "object" || resolved.properties !== undefined) {
    return {
      properties: resolved.properties ?? {},
      required: new Set(resolved.required ?? []),
    };
  }
}

function getRequestBodyDefinition(
  document: OpenApiDocument,
  operation: OpenApiOperation,
): {
  readonly body: RequestBodyDefinition;
  readonly schema: OpenApiSchema;
} {
  const content = operation.requestBody?.content ?? {};

  for (const contentType of [
    "application/vnd.denoland.eszip",
    "multipart/form-data",
    "application/x-www-form-urlencoded",
  ] as const) {
    const bodySchema = content[contentType]?.schema;
    if (bodySchema) {
      return {
        body: {
          kind: "body",
          contentType,
          field: "body",
        },
        schema: resolveSchema(document, bodySchema),
      };
    }
  }

  const jsonSchema = content["application/json"]?.schema;
  if (jsonSchema) {
    const shape = getObjectShape(document, jsonSchema);
    if (shape) {
      return {
        body: {
          kind: "json",
          contentType: "application/json",
          fields: Object.keys(shape.properties),
        },
        schema: resolveSchema(document, jsonSchema),
      };
    }
    return {
      body: {
        kind: "body",
        contentType: "application/json",
        field: "body",
      },
      schema: resolveSchema(document, jsonSchema),
    };
  }

  return {
    body: { kind: "none" },
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

function getResponseDefinition(
  document: OpenApiDocument,
  operation: OpenApiOperation,
): {
  readonly response: ResponseDefinition;
  readonly schema?: OpenApiSchema;
} {
  const entries = Object.entries(operation.responses ?? {}).sort(([left], [right]) => {
    if (left === "default") return 1;
    if (right === "default") return -1;
    return Number(left) - Number(right);
  });

  for (const [status, response] of entries) {
    if (status !== "default" && !status.startsWith("2")) {
      continue;
    }

    const jsonSchema = response.content?.["application/json"]?.schema;
    if (jsonSchema) {
      return {
        response: { kind: "json" },
        schema: resolveSchema(document, jsonSchema),
      };
    }

    const textSchema = response.content?.["text/plain"]?.schema;
    if (textSchema) {
      return {
        response: { kind: "text" },
        schema: resolveSchema(document, textSchema),
      };
    }

    if (response.content === undefined) {
      return {
        response: { kind: "void" },
      };
    }
  }

  return {
    response: { kind: "void" },
  };
}

function buildCombinedInputSchema(
  document: OpenApiDocument,
  operation: OpenApiOperation,
  requestBody: RequestBodyDefinition,
  requestBodySchema: OpenApiSchema,
): OpenApiSchema {
  const properties: Record<string, OpenApiSchema> = {};
  const required = new Set<string>();

  for (const parameter of operation.parameters ?? []) {
    if (parameter.in === "cookie" || parameter.schema === undefined) {
      continue;
    }
    properties[parameter.name] = resolveSchema(document, parameter.schema);
    if (parameter.required === true) {
      required.add(parameter.name);
    }
  }

  if (requestBody.kind === "json") {
    const shape = getObjectShape(document, requestBodySchema);
    if (shape) {
      Object.assign(properties, shape.properties);
      for (const key of shape.required) {
        required.add(key);
      }
    }
  } else if (requestBody.kind === "body") {
    properties.body = requestBodySchema;
    if (operation.requestBody?.required === true) {
      required.add("body");
    }
  }

  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function extractOperations(document: OpenApiDocument): ReadonlyArray<OperationDefinition> {
  const operations: Array<OperationDefinition> = [];

  for (const [pathName, pathItem] of Object.entries(document.paths)) {
    for (const method of httpMethodOrder) {
      const operation = pathItem[method];
      if (!operation?.operationId) {
        continue;
      }

      const { body, schema: requestBodySchema } = getRequestBodyDefinition(document, operation);
      const { response, schema: outputSchema } = getResponseDefinition(document, operation);
      const schemaBase = identifier(operation.operationId);
      const description = operation.description?.trim() || operation.summary?.trim() || schemaBase;

      operations.push({
        operationId: operation.operationId,
        operationName: camelize(operation.operationId),
        schemaBase,
        method: httpMethods[method],
        path: pathName,
        description,
        pathParams: (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name),
        queryParams: (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "query")
          .map((parameter) => parameter.name),
        headerParams: (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "header")
          .map((parameter) => parameter.name),
        requestBody: body,
        response,
        inputSchemaName: `${schemaBase}Input`,
        outputSchemaName: `${schemaBase}Output`,
        inputSchema: buildCombinedInputSchema(document, operation, body, requestBodySchema),
        outputSchema,
      });
    }
  }

  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function renderSchemaSource(
  document: OpenApiDocument,
  operations: ReadonlyArray<OperationDefinition>,
): string {
  const schemaEntries = operations.flatMap((operation) => {
    const entries: Array<{ readonly name: string; readonly schema: OpenApiSchema }> = [
      {
        name: operation.inputSchemaName,
        schema: operation.inputSchema,
      },
    ];

    if (operation.response.kind !== "void" && operation.outputSchema) {
      entries.push({
        name: operation.outputSchemaName,
        schema: operation.outputSchema,
      });
    }

    return entries;
  });

  const definitions = Object.fromEntries(
    Object.entries(document.components?.schemas ?? {}).map(([name, schema]) => [
      name,
      normalizeNullableJsonSchema(
        JsonSchema.fromSchemaOpenApi3_0(sanitizeOpenApiSchema(schema)).schema,
      ),
    ]),
  );

  const nameMap = schemaEntries.map((entry) => entry.name);
  const schemas = schemaEntries.map((entry) =>
    normalizeNullableJsonSchema(JsonSchema.fromSchemaOpenApi3_0(entry.schema).schema),
  );

  if (!Arr.isArrayNonEmpty(schemas)) {
    return "";
  }

  const multiDocument = SchemaRepresentation.fromJsonSchemaMultiDocument(
    {
      dialect: "draft-2020-12",
      definitions,
      schemas,
    },
    {
      onEnter(schema) {
        const next = { ...schema };
        if (next.type === "object" && next.additionalProperties === undefined) {
          next.additionalProperties = false;
        }
        return next;
      },
    },
  );

  const codeDocument = SchemaRepresentation.toCodeDocument(multiDocument);
  const hasBinaryInputs = operations.some((operation) =>
    containsBinarySchema(operation.inputSchema),
  );

  const parts: Array<string> = [];
  if (codeDocument.references.nonRecursives.length > 0) {
    parts.push("// non-recursive definitions");
    for (const reference of codeDocument.references.nonRecursives) {
      parts.push(
        `export const ${reference.$ref} = ${
          hasBinaryInputs ? replaceBinarySchemaCode(reference.code.runtime) : reference.code.runtime
        }`,
      );
    }
  }

  const recursiveEntries = Object.entries(codeDocument.references.recursives);
  if (recursiveEntries.length > 0) {
    parts.push("// recursive definitions");
    for (const [name, code] of recursiveEntries) {
      parts.push(
        `export const ${name} = ${hasBinaryInputs ? replaceBinarySchemaCode(code.runtime) : code.runtime}`,
      );
    }
  }

  if (hasBinaryInputs) {
    parts.push("// binary input helpers");
    parts.push(
      'export const BinaryInput = Schema.Union([Schema.Uint8Array, Schema.instanceOf(globalThis.ArrayBuffer, { expected: "ArrayBuffer" }), Schema.instanceOf(globalThis.Blob, { expected: "Blob" })])',
    );
  }

  if (codeDocument.codes.length > 0) {
    parts.push("// operation schemas");
    for (const [index, code] of codeDocument.codes.entries()) {
      const name = nameMap[index]!;
      parts.push(
        `export const ${name} = ${hasBinaryInputs ? replaceBinarySchemaCode(code.runtime) : code.runtime}`,
      );
    }
  }

  for (const operation of operations) {
    if (operation.response.kind === "void") {
      parts.push(`export const ${operation.outputSchemaName} = Schema.Void`);
    }
  }

  return parts.join("\n") + "\n";
}

function renderRequestBody(definition: RequestBodyDefinition): string {
  if (definition.kind === "none") {
    return '{ kind: "none" }';
  }
  if (definition.kind === "json") {
    return `{ kind: "json", contentType: "application/json", fields: ${JSON.stringify(definition.fields)} }`;
  }
  return `{ kind: "body", contentType: ${JSON.stringify(definition.contentType)}, field: "body" }`;
}

function renderResponse(definition: ResponseDefinition): string {
  return `{ kind: ${JSON.stringify(definition.kind)} }`;
}

function renderContracts(
  document: OpenApiDocument,
  operations: ReadonlyArray<OperationDefinition>,
): string {
  const schemaSource = renderSchemaSource(document, operations);
  const openApiOperationIdMapSource = operations
    .map(
      (operation) =>
        `  ${JSON.stringify(operation.operationId)}: ${JSON.stringify(operation.operationName)},`,
    )
    .join("\n");
  const definitionsSource = operations
    .map((operation) => {
      return `  ${JSON.stringify(operation.operationName)}: {
    id: ${JSON.stringify(operation.operationName)},
    description: ${JSON.stringify(operation.description)},
    method: ${JSON.stringify(operation.method)},
    path: ${JSON.stringify(operation.path)},
    pathParams: ${JSON.stringify(operation.pathParams)},
    queryParams: ${JSON.stringify(operation.queryParams)},
    headerParams: ${JSON.stringify(operation.headerParams)},
    requestBody: ${renderRequestBody(operation.requestBody)},
    response: ${renderResponse(operation.response)},
    inputSchema: ${operation.inputSchemaName},
    outputSchema: ${operation.outputSchemaName},
  },`;
    })
    .join("\n");

  return `import * as Schema from "effect/Schema";

${schemaSource}
export const openApiOperationIdMap = {
${openApiOperationIdMapSource}
} as const;

export const operationDefinitions = {
${definitionsSource}
} as const;

export type OpenApiOperationId = keyof typeof openApiOperationIdMap;
export type OperationId = keyof typeof operationDefinitions;
export type OperationDefinition<Id extends OperationId = OperationId> = (typeof operationDefinitions)[Id];
export type OperationInput<Id extends OperationId> = typeof operationDefinitions[Id]["inputSchema"]["Type"];
export type OperationOutput<Id extends OperationId> = typeof operationDefinitions[Id]["outputSchema"]["Type"];
export type JsonOperationDefinition<Id extends OperationId = OperationId> = Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "json" } }
>;
export type TextOperationDefinition<Id extends OperationId = OperationId> = Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "text" } }
>;
export type VoidOperationDefinition<Id extends OperationId = OperationId> = Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "void" } }
>;
`;
}

function splitOperationVersion(operationName: string): {
  readonly version: string;
  readonly methodName: string;
} {
  const match = /^((?:v|V)\d+)(.+)$/u.exec(operationName);
  if (!match) {
    throw new Error(`Expected a version-prefixed operation id, got ${operationName}`);
  }

  const [, version, methodBase] = match;
  if (version === undefined || methodBase === undefined || methodBase.length === 0) {
    throw new Error(`Expected an operation method segment after the version in ${operationName}`);
  }
  const first = methodBase.slice(0, 1).toLowerCase();

  return {
    version,
    methodName: `${first}${methodBase.slice(1)}`,
  };
}

function renderEffectClient(operations: ReadonlyArray<OperationDefinition>): string {
  const versionedOperations = new Map<string, Array<OperationDefinition>>();
  for (const operation of operations) {
    const { version } = splitOperationVersion(operation.operationName);
    const group = versionedOperations.get(version);
    if (group === undefined) {
      versionedOperations.set(version, [operation]);
    } else {
      group.push(operation);
    }
  }

  const versionedOperationsSource = [...versionedOperations.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([version, groupedOperations]) => {
      const methods = groupedOperations
        .map((operation) => {
          const { methodName } = splitOperationVersion(operation.operationName);
          const isEmptyInput =
            operation.inputSchema.type === "object" &&
            Object.keys(operation.inputSchema.properties ?? {}).length === 0;
          const signature = isEmptyInput
            ? ""
            : `input: typeof operationDefinitions.${operation.operationName}.inputSchema.Type`;
          const inputExpression = isEmptyInput ? "{}" : "input";

          return `    ${methodName}: (
      ${signature}
    ): Effect.Effect<typeof operationDefinitions.${operation.operationName}.outputSchema.Type, SupabaseApiError, SupabaseApiClient> =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        return yield* client.execute<${JSON.stringify(operation.operationName)}>(
          operationDefinitions.${operation.operationName},
          ${inputExpression},
        );
      }),`;
        })
        .join("\n");

      return `  ${version}: {
${methods}
  },`;
    })
    .join("\n");

  const executorCases = operations
    .map((operation) => {
      const { version, methodName } = splitOperationVersion(operation.operationName);
      const isEmptyInput =
        operation.inputSchema.type === "object" &&
        Object.keys(operation.inputSchema.properties ?? {}).length === 0;
      const decodedExpression = `Schema.decodeUnknownEffect(operationDefinitions.${operation.operationName}.inputSchema)(input)`;
      const decodedParam = isEmptyInput ? "_decoded" : "decoded";
      const callExpression = isEmptyInput
        ? `api.${version}.${methodName}()`
        : `api.${version}.${methodName}(decoded)`;

      return `    case ${JSON.stringify(operation.operationName)}:
      return ${decodedExpression}.pipe(
        Effect.flatMap((${decodedParam}) => ${callExpression}),
      );`;
    })
    .join("\n");

  return `import { Effect, Schema } from "effect";

import type { EffectClient } from "../internal/effect-client.ts";
import type { SupabaseApiError } from "../internal/client.ts";
import { SupabaseApiClient } from "../internal/client.ts";
import { operationDefinitions } from "./contracts.ts";

export const versionedEffectOperations = {
${versionedOperationsSource}
} as const;

export type GeneratedEffectOperations = typeof versionedEffectOperations;
type GeneratedApiClient = EffectClient<GeneratedEffectOperations>;

export function executeApiClientOperation(
  operationId: keyof typeof operationDefinitions,
  api: GeneratedApiClient,
  input: unknown,
) {
  switch (operationId) {
${executorCases}
  }
}
`;
}

function main() {
  const document = loadSpec();
  const operations = extractOperations(document);

  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });

  writeFileSync(path.join(generatedDir, "contracts.ts"), renderContracts(document, operations));
  writeFileSync(path.join(generatedDir, "effect-client.ts"), renderEffectClient(operations));
  writeFileSync(path.join(generatedDir, "openapi.json"), `${JSON.stringify(document, null, 2)}\n`);

  console.log(`Generated ${operations.length} API operations in ${generatedDir}`);
}

main();

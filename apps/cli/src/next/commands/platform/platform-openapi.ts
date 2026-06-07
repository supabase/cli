import openApiDocumentJson from "@supabase/api/openapi.json";
import {
  openApiOperationIdMap,
  operationDefinitions,
  type OperationDefinition,
  type OperationId,
} from "@supabase/api/effect";

import { PlatformMetadataError } from "./platform.errors.ts";
import type { PlatformHttpMethod } from "./platform-types.ts";

type OpenApiHttpMethod = Lowercase<PlatformHttpMethod>;

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

type OpenApiMediaType = {
  schema?: OpenApiSchema;
};

type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
};

type OpenApiRequestBody = {
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
};

type OpenApiResponse = {
  content?: Record<string, OpenApiMediaType>;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  parameters?: ReadonlyArray<OpenApiParameter>;
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
};

type OpenApiPathItem = Partial<Record<OpenApiHttpMethod, OpenApiOperation>> & {
  parameters?: ReadonlyArray<OpenApiParameter>;
};

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
};

type ObjectShape = {
  readonly properties: Record<string, OpenApiSchema>;
  readonly required: ReadonlySet<string>;
};

export type PlatformOpenApiSchema = OpenApiSchema;
export type PlatformOpenApiParameter = OpenApiParameter;
type PlatformOpenApiRequestBody = OpenApiRequestBody;
export type PlatformOpenApiResponse = OpenApiResponse;

export type PlatformOpenApiOperationEntry = {
  readonly rawOperationId: string;
  readonly sdkOperationId: OperationId;
  readonly definition: OperationDefinition;
  readonly method: PlatformHttpMethod;
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: ReadonlyArray<string>;
  readonly parameters: ReadonlyArray<PlatformOpenApiParameter>;
  readonly requestBody?: PlatformOpenApiRequestBody;
  readonly responses?: Record<string, PlatformOpenApiResponse>;
};

const httpMethodOrder = ["get", "post", "put", "patch", "delete", "head"] as const;
const httpMethods: Record<OpenApiHttpMethod, PlatformHttpMethod> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSchema(value: unknown): OpenApiSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function parseParameter(value: unknown): OpenApiParameter | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return;
  }
  if (
    value.in !== "path" &&
    value.in !== "query" &&
    value.in !== "header" &&
    value.in !== "cookie"
  ) {
    return;
  }

  const schema = parseSchema(value.schema);
  return {
    name: value.name,
    in: value.in,
    ...(typeof value.required === "boolean" ? { required: value.required } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(schema ? { schema } : {}),
  };
}

function parseRequestBody(value: unknown): OpenApiRequestBody | undefined {
  if (!isRecord(value)) {
    return;
  }

  const content: Record<string, OpenApiMediaType> = {};
  if (isRecord(value.content)) {
    for (const [contentType, mediaType] of Object.entries(value.content)) {
      if (!isRecord(mediaType)) {
        continue;
      }

      const schema = parseSchema(mediaType.schema);
      content[contentType] = schema ? { schema } : {};
    }
  }

  return {
    ...(typeof value.required === "boolean" ? { required: value.required } : {}),
    ...(Object.keys(content).length > 0 ? { content } : {}),
  };
}

function parseResponse(value: unknown): OpenApiResponse | undefined {
  if (!isRecord(value)) {
    return;
  }

  const content: Record<string, OpenApiMediaType> = {};
  if (isRecord(value.content)) {
    for (const [contentType, mediaType] of Object.entries(value.content)) {
      if (!isRecord(mediaType)) {
        continue;
      }

      const schema = parseSchema(mediaType.schema);
      content[contentType] = schema ? { schema } : {};
    }
  }

  return Object.keys(content).length > 0 ? { content } : {};
}

function parseOperation(value: unknown): OpenApiOperation | undefined {
  if (!isRecord(value)) {
    return;
  }

  const parameters = Array.isArray(value.parameters)
    ? value.parameters.flatMap((parameter: unknown) => {
        const parsed = parseParameter(parameter);
        return parsed ? [parsed] : [];
      })
    : undefined;

  const requestBody = parseRequestBody(value.requestBody);
  const tags =
    Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
      ? value.tags
      : undefined;
  const responses: Record<string, OpenApiResponse> = {};
  if (isRecord(value.responses)) {
    for (const [status, response] of Object.entries(value.responses)) {
      const parsed = parseResponse(response);
      if (parsed !== undefined) {
        responses[status] = parsed;
      }
    }
  }

  return {
    ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(parameters && parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...(Object.keys(responses).length > 0 ? { responses } : {}),
  };
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function loadOpenApiDocument(): OpenApiDocument {
  const document: unknown = openApiDocumentJson;
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new PlatformMetadataError({
      message: "The exported @supabase/api OpenAPI document is invalid.",
    });
  }

  const paths: Record<string, OpenApiPathItem> = {};
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }

    const parsedPathItem: OpenApiPathItem = {};
    if (Array.isArray(pathItem.parameters)) {
      const parameters = pathItem.parameters.flatMap((parameter: unknown) => {
        const parsed = parseParameter(parameter);
        return parsed ? [parsed] : [];
      });
      if (parameters.length > 0) {
        parsedPathItem.parameters = parameters;
      }
    }

    for (const method of httpMethodOrder) {
      const parsed = parseOperation(pathItem[method]);
      if (parsed !== undefined) {
        parsedPathItem[method] = parsed;
      }
    }

    paths[path] = parsedPathItem;
  }

  const schemas: Record<string, OpenApiSchema> = {};
  if (isRecord(document.components) && isRecord(document.components.schemas)) {
    for (const [name, schema] of Object.entries(document.components.schemas)) {
      const parsed = parseSchema(schema);
      if (parsed !== undefined) {
        schemas[name] = parsed;
      }
    }
  }

  return {
    openapi: typeof document.openapi === "string" ? document.openapi : "3.0.0",
    paths,
    ...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
  };
}

function mergeParameters(
  pathParameters: ReadonlyArray<OpenApiParameter> | undefined,
  operationParameters: ReadonlyArray<OpenApiParameter> | undefined,
): ReadonlyArray<OpenApiParameter> {
  const merged = new Map<string, OpenApiParameter>();

  for (const parameter of pathParameters ?? []) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  for (const parameter of operationParameters ?? []) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }

  return [...merged.values()];
}

const openApiDocument = loadOpenApiDocument();
const openApiToSdkOperationId = new Map<string, OperationId>(Object.entries(openApiOperationIdMap));

export function resolvePlatformOpenApiSchema(schema: OpenApiSchema): OpenApiSchema {
  if (schema.$ref) {
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix)) {
      throw new PlatformMetadataError({
        message: "Encountered an unsupported OpenAPI schema ref.",
        detail: schema.$ref,
      });
    }

    const name = schema.$ref.slice(prefix.length);
    const target = openApiDocument.components?.schemas?.[name];
    if (target === undefined) {
      throw new PlatformMetadataError({
        message: "Encountered a missing OpenAPI schema ref.",
        detail: schema.$ref,
      });
    }

    return resolvePlatformOpenApiSchema(target);
  }

  if (schema.allOf && schema.allOf.length > 0) {
    const shapes = schema.allOf
      .map((member) => getPlatformOpenApiObjectShape(member))
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
        deprecated: schema.deprecated,
        format: schema.format,
        additionalProperties: schema.additionalProperties,
      };
    }
  }

  return schema;
}

export function getPlatformOpenApiObjectShape(schema: OpenApiSchema): ObjectShape | undefined {
  const resolved = resolvePlatformOpenApiSchema(schema);
  if (resolved.type === "object" || resolved.properties !== undefined) {
    return {
      properties: resolved.properties ?? {},
      required: new Set(resolved.required ?? []),
    };
  }
}

export const platformOpenApiOperationEntries: ReadonlyArray<PlatformOpenApiOperationEntry> =
  Object.entries(openApiDocument.paths)
    .flatMap(([path, pathItem]) =>
      httpMethodOrder.flatMap((method) => {
        const operation = pathItem[method];
        if (operation?.operationId === undefined) {
          return [];
        }

        const sdkOperationId = openApiToSdkOperationId.get(operation.operationId);
        if (sdkOperationId === undefined) {
          throw new PlatformMetadataError({
            message: "No SDK operation id mapping was found for an OpenAPI operation.",
            detail: operation.operationId,
          });
        }

        const definition = operationDefinitions[sdkOperationId];
        const summary = normalizeText(operation.summary);
        const description = normalizeText(operation.description);

        return [
          {
            rawOperationId: operation.operationId,
            sdkOperationId,
            definition,
            method: httpMethods[method],
            path,
            ...(summary ? { summary } : {}),
            ...(description ? { description } : {}),
            tags: operation.tags ?? [],
            parameters: mergeParameters(pathItem.parameters, operation.parameters),
            requestBody: operation.requestBody,
            responses: operation.responses,
          },
        ];
      }),
    )
    .sort((left, right) => left.rawOperationId.localeCompare(right.rawOperationId));

import { PlatformMetadataError } from "./platform.errors.ts";
import type {
  PlatformOpenApiOperationEntry,
  PlatformOpenApiParameter,
  PlatformOpenApiResponse,
  PlatformOpenApiSchema,
} from "./platform-openapi.ts";
import { getPlatformOpenApiObjectShape, resolvePlatformOpenApiSchema } from "./platform-openapi.ts";
import type {
  PlatformOperationDescriptor,
  PlatformSchemaKind,
  PlatformSchemaNode,
} from "./platform-types.ts";

function humanizeFieldName(name: string): string {
  return name
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function isSensitiveField(name: string): boolean {
  return /(pass(word)?|secret|token|jwt|private[_-]?key|db[_-]?pass)/i.test(name);
}

function enumValuesFor(schema: PlatformOpenApiSchema): ReadonlyArray<string> | undefined {
  const resolved = resolvePlatformOpenApiSchema(schema);
  if (resolved.enum === undefined || resolved.enum.length === 0) {
    return;
  }

  const values = resolved.enum.filter((value) => typeof value === "string");
  if (values.length !== resolved.enum.length) {
    return;
  }
  return values;
}

function unionVariantsFor(schema: PlatformOpenApiSchema): ReadonlyArray<PlatformOpenApiSchema> {
  const resolved = resolvePlatformOpenApiSchema(schema);
  return [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])];
}

type StringOnlyUnionMetadata =
  | {
      readonly kind: "string";
    }
  | {
      readonly kind: "enum";
      readonly enumValues: ReadonlyArray<string>;
    };

function stringOnlyUnionMetadataFor(
  schema: PlatformOpenApiSchema,
): StringOnlyUnionMetadata | undefined {
  const variants = unionVariantsFor(schema);
  if (variants.length === 0) {
    return;
  }

  const variantMetadata = variants
    .map((variant) => {
      const resolved = resolvePlatformOpenApiSchema(variant);
      const enumValues = enumValuesFor(variant);

      if (enumValues !== undefined && enumValues.length > 0) {
        return { kind: "enum" as const, enumValues };
      }

      if (resolved.type === "string") {
        return { kind: "string" as const };
      }
    })
    .filter(
      (
        variant,
      ): variant is
        | { readonly kind: "string" }
        | { readonly kind: "enum"; readonly enumValues: ReadonlyArray<string> } =>
        variant !== undefined,
    );

  if (variantMetadata.length !== variants.length) {
    return;
  }

  if (variantMetadata.some((variant) => variant.kind === "string")) {
    return { kind: "string" };
  }

  const enumValues = [
    ...new Set(
      variantMetadata.flatMap((variant) => (variant.kind === "enum" ? variant.enumValues : [])),
    ),
  ];
  return {
    kind: "enum",
    enumValues,
  };
}

function enumValuesForNode(schema: PlatformOpenApiSchema): ReadonlyArray<string> | undefined {
  const stringOnlyUnion = stringOnlyUnionMetadataFor(schema);
  if (stringOnlyUnion?.kind === "enum") {
    return stringOnlyUnion.enumValues;
  }

  return enumValuesFor(schema);
}

function classifyPlatformSchemaKind(schema: PlatformOpenApiSchema): PlatformSchemaKind {
  const stringOnlyUnion = stringOnlyUnionMetadataFor(schema);
  if (stringOnlyUnion !== undefined) {
    return stringOnlyUnion.kind;
  }

  const resolved = resolvePlatformOpenApiSchema(schema);
  const enumValues = enumValuesForNode(schema);
  if (enumValues !== undefined && enumValues.length > 1) {
    return "enum";
  }
  if (unionVariantsFor(schema).length > 0) {
    return "union";
  }

  switch (resolved.type) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return resolved.properties !== undefined ? "object" : "unknown";
  }
}

function toPlatformSchemaNode(options: {
  readonly schema: PlatformOpenApiSchema;
  readonly name?: string;
  readonly label?: string;
  readonly location?: "path" | "query" | "header" | "body";
  readonly required: boolean;
  readonly sensitive: boolean;
  readonly description?: string;
}): PlatformSchemaNode {
  const resolved = resolvePlatformOpenApiSchema(options.schema);
  const objectShape = getPlatformOpenApiObjectShape(options.schema);
  const kind = classifyPlatformSchemaKind(options.schema);
  const enumValues = enumValuesForNode(options.schema);
  const unionVariants = unionVariantsFor(options.schema);

  const properties =
    objectShape && Object.keys(objectShape.properties).length > 0
      ? Object.entries(objectShape.properties).map(([name, schema]) =>
          toPlatformSchemaNode({
            schema,
            name,
            label: humanizeFieldName(name),
            required: objectShape.required.has(name),
            sensitive: isSensitiveField(name),
          }),
        )
      : undefined;

  const items =
    resolved.type === "array" && resolved.items !== undefined
      ? toPlatformSchemaNode({
          schema: resolved.items,
          label: options.label ? `${options.label} Item` : "Item",
          required: true,
          sensitive: options.sensitive,
        })
      : undefined;

  const variants =
    unionVariants.length > 0
      ? unionVariants.map((variant, index) =>
          toPlatformSchemaNode({
            schema: variant,
            label: options.label ? `${options.label} Variant ${index + 1}` : `Variant ${index + 1}`,
            required: options.required,
            sensitive: options.sensitive,
          }),
        )
      : undefined;

  return {
    ...(options.name ? { name: options.name } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(typeof (options.description ?? resolved.description) === "string"
      ? { description: options.description ?? resolved.description }
      : {}),
    ...(options.location ? { location: options.location } : {}),
    kind,
    required: options.required,
    nullable: resolved.nullable === true,
    sensitive: options.sensitive,
    ...(resolved.deprecated === true ? { deprecated: true } : {}),
    ...(typeof resolved.format === "string" ? { format: resolved.format } : {}),
    ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
    ...(properties && properties.length > 0 ? { properties } : {}),
    ...(items ? { items } : {}),
    ...(variants && variants.length > 0 && kind === "union" ? { variants } : {}),
  };
}

function parameterSchema(parameter: PlatformOpenApiParameter): PlatformOpenApiSchema | undefined {
  return parameter.schema ? resolvePlatformOpenApiSchema(parameter.schema) : undefined;
}

function requestBodySchema(
  entry: PlatformOpenApiOperationEntry,
  contentType: string,
): PlatformOpenApiSchema | undefined {
  const schema = entry.requestBody?.content?.[contentType]?.schema;
  return schema ? resolvePlatformOpenApiSchema(schema) : undefined;
}

function requestBodyKind(
  contentType: string,
): PlatformOperationDescriptor["request"]["body"]["kind"] {
  if (contentType === "application/json") {
    return "json";
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return "urlencoded";
  }
  if (contentType === "multipart/form-data") {
    return "multipart";
  }
  return "binary";
}

function buildRequestParams(
  entry: PlatformOpenApiOperationEntry,
): ReadonlyArray<PlatformSchemaNode> {
  return entry.parameters.flatMap((parameter) => {
    if (parameter.in === "cookie") {
      return [];
    }

    const schema = parameterSchema(parameter);
    if (schema === undefined) {
      return [];
    }

    return [
      toPlatformSchemaNode({
        schema,
        name: parameter.name,
        label: humanizeFieldName(parameter.name),
        location: parameter.in,
        required: parameter.required === true,
        sensitive: isSensitiveField(parameter.name),
        description: parameter.description,
      }),
    ];
  });
}

function buildRequestBody(
  entry: PlatformOpenApiOperationEntry,
): PlatformOperationDescriptor["request"]["body"] {
  const content = entry.requestBody?.content ?? {};
  const contentType =
    [
      "application/vnd.denoland.eszip",
      "multipart/form-data",
      "application/x-www-form-urlencoded",
    ].find((candidate) => content[candidate] !== undefined) ??
    (content["application/json"] ? "application/json" : undefined);

  if (contentType === undefined) {
    return { kind: "none" };
  }

  const schema = requestBodySchema(entry, contentType);
  if (schema === undefined) {
    throw new PlatformMetadataError({
      message: "Encountered a request body without a schema in the exported OpenAPI document.",
      detail: `${entry.rawOperationId} (${contentType})`,
    });
  }

  const objectShape = getPlatformOpenApiObjectShape(schema);
  if (contentType === "application/json" && objectShape !== undefined) {
    const bodyProperties = Object.entries(objectShape.properties).map(([name, property]) =>
      toPlatformSchemaNode({
        schema: property,
        name,
        label: humanizeFieldName(name),
        location: "body",
        required: objectShape.required.has(name),
        sensitive: isSensitiveField(name),
      }),
    );

    return {
      kind: "json",
      contentType,
      schema: {
        label: "JSON Body",
        location: "body",
        kind: "object",
        required: entry.requestBody?.required !== false,
        nullable: schema.nullable === true,
        sensitive: false,
        ...(bodyProperties.length > 0 ? { properties: bodyProperties } : {}),
      },
    };
  }

  return {
    kind: requestBodyKind(contentType),
    contentType,
    fieldName: "body",
    schema: toPlatformSchemaNode({
      schema,
      name: "body",
      label: "Body",
      location: "body",
      required: entry.requestBody?.required === true,
      sensitive: false,
    }),
  };
}

function responseSchema(
  responses: Record<string, PlatformOpenApiResponse> | undefined,
): PlatformOpenApiSchema | undefined {
  const entries = Object.entries(responses ?? {}).sort(([left], [right]) => {
    if (left === "default") {
      return 1;
    }
    if (right === "default") {
      return -1;
    }
    return Number(left) - Number(right);
  });

  for (const [status, response] of entries) {
    if (status !== "default" && !status.startsWith("2")) {
      continue;
    }

    const jsonSchema = response.content?.["application/json"]?.schema;
    if (jsonSchema !== undefined) {
      return resolvePlatformOpenApiSchema(jsonSchema);
    }

    const textSchema = response.content?.["text/plain"]?.schema;
    if (textSchema !== undefined) {
      return resolvePlatformOpenApiSchema(textSchema);
    }

    if (response.content === undefined) {
      return;
    }
  }
}

export function buildPlatformRequestDescriptor(
  entry: PlatformOpenApiOperationEntry,
): PlatformOperationDescriptor["request"] {
  return {
    params: buildRequestParams(entry),
    body: buildRequestBody(entry),
  };
}

export function buildPlatformResponseSchema(
  entry: PlatformOpenApiOperationEntry,
): PlatformSchemaNode {
  const schema = responseSchema(entry.responses);
  if (schema === undefined) {
    return {
      label: "Response",
      kind: "unknown",
      required: true,
      nullable: false,
      sensitive: false,
      description: "No response body.",
    };
  }

  return toPlatformSchemaNode({
    schema,
    label: "Response",
    required: true,
    sensitive: false,
  });
}

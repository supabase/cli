import { formatPlatformApiCommand } from "./platform-cli.ts";
import { buildPlatformGeneratedExamples } from "./platform-examples.ts";
import type {
  PlatformGeneratedExamples,
  PlatformOperationDescriptor,
  PlatformSchemaNode,
} from "./platform-types.ts";

type ApiSchema =
  | {
      readonly type: "string" | "boolean" | "integer" | "number" | "unknown";
      readonly description?: string;
      readonly format?: string;
      readonly enum?: ReadonlyArray<string>;
      readonly sensitive?: true;
      readonly nullable?: true;
      readonly deprecated?: true;
    }
  | {
      readonly type: "object";
      readonly description?: string;
      readonly sensitive?: true;
      readonly nullable?: true;
      readonly deprecated?: true;
      readonly properties?: Record<string, ApiSchema>;
      readonly required?: ReadonlyArray<string>;
    }
  | {
      readonly type: "array";
      readonly description?: string;
      readonly sensitive?: true;
      readonly nullable?: true;
      readonly deprecated?: true;
      readonly items?: ApiSchema;
    }
  | {
      readonly oneOf: ReadonlyArray<ApiSchema>;
      readonly description?: string;
      readonly sensitive?: true;
      readonly nullable?: true;
      readonly deprecated?: true;
    };

type ApiFieldGroups = {
  readonly required?: Record<string, ApiSchema>;
  readonly optional?: Record<string, ApiSchema>;
};

type ApiInputChannel = ApiFieldGroups & {
  readonly flag: string;
  readonly schema?: ApiSchema;
};

type ApiInputGuidance = {
  readonly summary: string;
  readonly notes?: ReadonlyArray<string>;
};

type ApiBodyChannels = {
  readonly json?: ApiInputChannel;
  readonly upload?: ApiInputChannel;
  readonly body?: ApiInputChannel;
};

type PlatformSchemaDocument = {
  readonly route: string;
  readonly method: PlatformOperationDescriptor["method"];
  readonly command: string;
  readonly summary: string;
  readonly description: string;
  readonly input: {
    readonly params?: ApiFieldGroups & {
      readonly flag: "--params";
      readonly guidance?: string;
    };
    readonly body?: {
      readonly kind: PlatformOperationDescriptor["request"]["body"]["kind"];
      readonly required: boolean;
      readonly contentType?: string;
      readonly guidance?: ApiInputGuidance;
      readonly channels?: ApiBodyChannels;
    };
  };
  readonly response?: ApiSchema;
  readonly examples: ReadonlyArray<{
    readonly description: string;
    readonly command: string;
  }>;
  readonly projection: {
    readonly flag: "--fields";
    readonly available: ReadonlyArray<string>;
  };
};

function collectProjectionPaths(
  node: PlatformSchemaNode | undefined,
  prefix = "",
): ReadonlyArray<string> {
  if (node === undefined) {
    return [];
  }

  const currentPrefix = node.name
    ? prefix.length === 0
      ? node.name
      : `${prefix}.${node.name}`
    : prefix;

  const properties = node.properties ?? [];
  if (properties.length === 0) {
    return currentPrefix.length > 0 ? [currentPrefix] : [];
  }

  const nested = properties.flatMap((property) => collectProjectionPaths(property, currentPrefix));
  if (currentPrefix.length === 0) {
    return nested;
  }
  return [currentPrefix, ...nested];
}

function isBinaryNode(node: PlatformSchemaNode): boolean {
  return node.kind === "string" && node.format === "binary";
}

function isBinaryUploadNode(node: PlatformSchemaNode): boolean {
  return (
    isBinaryNode(node) ||
    (node.kind === "array" && node.items !== undefined && isBinaryNode(node.items))
  );
}

function schemaCommonFields(node: PlatformSchemaNode) {
  return {
    ...(node.description ? { description: node.description } : {}),
    ...(node.format ? { format: node.format } : {}),
    ...(node.sensitive ? { sensitive: true as const } : {}),
    ...(node.nullable ? { nullable: true as const } : {}),
    ...(node.deprecated ? { deprecated: true as const } : {}),
  };
}

function toApiSchema(node: PlatformSchemaNode): ApiSchema {
  switch (node.kind) {
    case "string":
    case "boolean":
    case "integer":
    case "number":
    case "unknown":
      return {
        type: node.kind,
        ...(node.enumValues && node.enumValues.length > 0 ? { enum: node.enumValues } : {}),
        ...schemaCommonFields(node),
      };
    case "enum":
      return {
        type: "string",
        ...(node.enumValues && node.enumValues.length > 0 ? { enum: node.enumValues } : {}),
        ...schemaCommonFields(node),
      };
    case "object": {
      const properties = Object.fromEntries(
        (node.properties ?? [])
          .filter(
            (property): property is PlatformSchemaNode & { name: string } =>
              property.name !== undefined,
          )
          .map((property) => [property.name, toApiSchema(property)] as const),
      );
      const required = (node.properties ?? [])
        .filter((property) => property.name !== undefined && property.required)
        .map((property) => property.name!);

      return {
        type: "object",
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        ...(required.length > 0 ? { required } : {}),
        ...schemaCommonFields(node),
      };
    }
    case "array":
      return {
        type: "array",
        ...(node.items ? { items: toApiSchema(node.items) } : {}),
        ...schemaCommonFields(node),
      };
    case "union":
      return {
        oneOf: (node.variants ?? []).map((variant) => toApiSchema(variant)),
        ...schemaCommonFields(node),
      };
  }
}

function buildApiFieldGroups(nodes: ReadonlyArray<PlatformSchemaNode>): ApiFieldGroups {
  const requiredEntries = nodes
    .filter(
      (node): node is PlatformSchemaNode & { name: string } =>
        node.name !== undefined && node.required,
    )
    .map((node) => [node.name, toApiSchema(node)] as const);
  const optionalEntries = nodes
    .filter(
      (node): node is PlatformSchemaNode & { name: string } =>
        node.name !== undefined && !node.required,
    )
    .map((node) => [node.name, toApiSchema(node)] as const);

  return {
    ...(requiredEntries.length > 0 ? { required: Object.fromEntries(requiredEntries) } : {}),
    ...(optionalEntries.length > 0 ? { optional: Object.fromEntries(optionalEntries) } : {}),
  };
}

function buildBodyGuidance(generatedExamples: PlatformGeneratedExamples) {
  const body = generatedExamples.inputHelp?.body;
  if (body === undefined) {
    return;
  }

  return {
    summary: body.summary,
    ...(body.notes && body.notes.length > 0 ? { notes: body.notes } : {}),
  };
}

function buildBodyChannels(descriptor: PlatformOperationDescriptor): ApiBodyChannels | undefined {
  const body = descriptor.request.body;
  const schema = body.schema;
  if (schema === undefined) {
    return;
  }

  if ((body.kind === "json" || body.kind === "urlencoded") && schema.kind === "object") {
    return {
      json: {
        flag: "--json",
        ...buildApiFieldGroups(schema.properties ?? []),
      },
    };
  }

  if (body.kind === "multipart" && schema.kind === "object") {
    const binaryNodes = (schema.properties ?? []).filter((property) =>
      isBinaryUploadNode(property),
    );
    const structuredNodes = (schema.properties ?? []).filter(
      (property) => !isBinaryUploadNode(property),
    );

    return {
      ...(structuredNodes.length > 0
        ? {
            json: {
              flag: "--json",
              ...buildApiFieldGroups(structuredNodes),
            },
          }
        : {}),
      ...(binaryNodes.length > 0
        ? {
            upload: {
              flag: "--upload",
              ...buildApiFieldGroups(binaryNodes),
            },
          }
        : {}),
    };
  }

  return {
    body: {
      flag: "--body",
      schema: toApiSchema(schema),
    },
  };
}

export function buildPlatformSchemaPayload(
  descriptor: PlatformOperationDescriptor,
): PlatformSchemaDocument {
  const generatedExamples = buildPlatformGeneratedExamples(descriptor);
  const bodyGuidance = buildBodyGuidance(generatedExamples);
  const bodyChannels = buildBodyChannels(descriptor);

  return {
    route: descriptor.path,
    method: descriptor.method,
    command: formatPlatformApiCommand(descriptor),
    summary: descriptor.shortDescription,
    description: descriptor.description,
    input: {
      ...(descriptor.request.params.length > 0
        ? {
            params: {
              flag: "--params" as const,
              ...(generatedExamples.inputHelp?.params
                ? { guidance: generatedExamples.inputHelp.params }
                : {}),
              ...buildApiFieldGroups(descriptor.request.params),
            },
          }
        : {}),
      ...(descriptor.request.body.kind !== "none"
        ? {
            body: {
              kind: descriptor.request.body.kind,
              required: descriptor.request.body.required,
              ...(descriptor.request.body.contentType
                ? { contentType: descriptor.request.body.contentType }
                : {}),
              ...(bodyGuidance ? { guidance: bodyGuidance } : {}),
              ...(bodyChannels ? { channels: bodyChannels } : {}),
            },
          }
        : {}),
    },
    ...(descriptor.responseSchema ? { response: toApiSchema(descriptor.responseSchema) } : {}),
    examples: generatedExamples.commandExamples,
    projection: {
      flag: "--fields",
      available: collectProjectionPaths(descriptor.responseSchema),
    },
  };
}

function summarizeApiSchema(schema: ApiSchema): string {
  if ("oneOf" in schema) {
    return `one of ${schema.oneOf.map((variant) => summarizeApiSchema(variant)).join(" | ")}`;
  }

  if (schema.type === "array") {
    if (schema.items === undefined) {
      return "array";
    }
    return `${summarizeApiSchema(schema.items)}[]`;
  }

  if (schema.type === "object") {
    return "object";
  }

  if (schema.type === "string" && schema.format === "binary") {
    return "binary";
  }

  if (schema.enum && schema.enum.length > 0) {
    return `string [${schema.enum.join(" | ")}]`;
  }

  return schema.type;
}

function schemaQualifiers(schema: ApiSchema): string {
  const qualifiers = [
    ...("sensitive" in schema && schema.sensitive ? ["sensitive"] : []),
    ...("nullable" in schema && schema.nullable ? ["nullable"] : []),
    ...("deprecated" in schema && schema.deprecated ? ["deprecated"] : []),
  ];

  return qualifiers.length > 0 ? ` (${qualifiers.join(", ")})` : "";
}

function quoteTypescriptLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function appendNullUnion(type: string): string {
  const parts = type.split(" | ");
  return parts.includes("null") ? type : `${type} | null`;
}

function summarizeResponseType(schema: ApiSchema): string {
  let type: string;

  if ("oneOf" in schema) {
    type = [...new Set(schema.oneOf.map((variant) => summarizeResponseType(variant)))].join(" | ");
  } else if (schema.type === "array") {
    const itemType = schema.items ? summarizeResponseType(schema.items) : "unknown";
    type = itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
  } else if (schema.type === "object") {
    type = "object";
  } else if (schema.type === "string" && schema.format === "binary") {
    type = "binary";
  } else if (schema.enum && schema.enum.length > 0) {
    type = schema.enum.map((value) => quoteTypescriptLiteral(value)).join(" | ");
  } else {
    type = schema.type;
  }

  return "nullable" in schema && schema.nullable ? appendNullUnion(type) : type;
}

function responseSchemaMetadataQualifiers(schema: ApiSchema): string {
  const qualifiers = [
    ...("sensitive" in schema && schema.sensitive ? ["sensitive"] : []),
    ...("deprecated" in schema && schema.deprecated ? ["deprecated"] : []),
  ];

  return qualifiers.length > 0 ? ` (${qualifiers.join(", ")})` : "";
}

function orderedObjectEntries(
  schema: Extract<ApiSchema, { readonly type: "object" }>,
): ReadonlyArray<readonly [string, ApiSchema, boolean]> {
  const properties = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);
  const entries = Object.entries(properties);

  return [
    ...entries
      .filter(([name]) => requiredSet.has(name))
      .map(([name, property]) => [name, property, true] as const),
    ...entries
      .filter(([name]) => !requiredSet.has(name))
      .map(([name, property]) => [name, property, false] as const),
  ];
}

function renderNamedSchema(
  name: string,
  schema: ApiSchema,
  indent: number,
  options: { readonly optional: boolean },
): ReadonlyArray<string> {
  const prefix = " ".repeat(indent);
  const description =
    "description" in schema && schema.description !== undefined ? ` - ${schema.description}` : "";
  const optionalName = options.optional ? `${name}?` : name;
  const line = `${prefix}${optionalName}: ${summarizeApiSchema(schema)}${schemaQualifiers(schema)}${description}`;

  if (
    "type" in schema &&
    schema.type === "object" &&
    schema.properties &&
    Object.keys(schema.properties).length > 0
  ) {
    return [
      line,
      ...orderedObjectEntries(schema).flatMap(([childName, childSchema, required]) =>
        renderNamedSchema(childName, childSchema, indent + 2, { optional: !required }),
      ),
    ];
  }

  if (
    "type" in schema &&
    schema.type === "array" &&
    schema.items &&
    "type" in schema.items &&
    schema.items.type === "object"
  ) {
    return [
      line,
      `${prefix}  items:`,
      ...orderedObjectEntries(schema.items).flatMap(([childName, childSchema, required]) =>
        renderNamedSchema(childName, childSchema, indent + 4, { optional: !required }),
      ),
    ];
  }

  return [line];
}

function renderResponseNamedSchema(
  name: string,
  schema: ApiSchema,
  indent: number,
  options: { readonly optional: boolean },
): ReadonlyArray<string> {
  const prefix = " ".repeat(indent);
  const description =
    "description" in schema && schema.description !== undefined ? ` - ${schema.description}` : "";
  const optionalName = options.optional ? `${name}?` : name;
  const line = `${prefix}${optionalName}: ${summarizeResponseType(schema)}${responseSchemaMetadataQualifiers(
    schema,
  )}${description}`;

  if (
    "type" in schema &&
    schema.type === "object" &&
    schema.properties &&
    Object.keys(schema.properties).length > 0
  ) {
    return [
      line,
      ...orderedObjectEntries(schema).flatMap(([childName, childSchema, required]) =>
        renderResponseNamedSchema(childName, childSchema, indent + 2, { optional: !required }),
      ),
    ];
  }

  if (
    "type" in schema &&
    schema.type === "array" &&
    schema.items &&
    "type" in schema.items &&
    schema.items.type === "object"
  ) {
    return [
      line,
      `${prefix}  items:`,
      ...orderedObjectEntries(schema.items).flatMap(([childName, childSchema, required]) =>
        renderResponseNamedSchema(childName, childSchema, indent + 4, { optional: !required }),
      ),
    ];
  }

  return [line];
}

function hasFieldGroups(
  channel: ApiInputChannel | undefined,
  kind: "required" | "optional",
): boolean {
  return kind === "required"
    ? channel?.required !== undefined && Object.keys(channel.required).length > 0
    : channel?.optional !== undefined && Object.keys(channel.optional).length > 0;
}

function renderFieldGroup(
  channel: ApiInputChannel,
  kind: "required" | "optional",
  indent: number,
): ReadonlyArray<string> {
  const fields = kind === "required" ? channel.required : channel.optional;
  if (fields === undefined) {
    return [];
  }

  return Object.entries(fields).flatMap(([name, schema]) =>
    renderNamedSchema(name, schema, indent, { optional: kind === "optional" }),
  );
}

function renderChannelSchema(
  channel: ApiInputChannel,
  optional: boolean,
  indent: number,
): ReadonlyArray<string> {
  if (channel.schema === undefined) {
    return [];
  }

  return renderNamedSchema("body", channel.schema, indent, { optional });
}

function shouldRenderBodyGuidance(payload: PlatformSchemaDocument): {
  readonly includeSummary: boolean;
  readonly includeNotes: boolean;
} {
  const channels = payload.input.body?.channels;
  const hasStructuredFields =
    (channels?.json?.required !== undefined && Object.keys(channels.json.required).length > 0) ||
    (channels?.json?.optional !== undefined && Object.keys(channels.json.optional).length > 0) ||
    (channels?.upload?.required !== undefined &&
      Object.keys(channels.upload.required).length > 0) ||
    (channels?.upload?.optional !== undefined && Object.keys(channels.upload.optional).length > 0);

  return {
    includeSummary: !hasStructuredFields,
    includeNotes:
      payload.input.body?.kind === "multipart" ||
      payload.input.body?.kind === "binary" ||
      payload.input.body?.kind === "urlencoded" ||
      !hasStructuredFields,
  };
}

function renderGuidanceLines(
  guidance: ApiInputGuidance | undefined,
  options: {
    readonly indent: number;
    readonly includeSummary: boolean;
    readonly includeNotes: boolean;
  },
): ReadonlyArray<string> {
  if (guidance === undefined) {
    return [];
  }

  const prefix = " ".repeat(options.indent);
  return [
    ...(options.includeSummary ? [`${prefix}hint: ${guidance.summary}`] : []),
    ...(options.includeNotes ? (guidance.notes ?? []).map((note) => `${prefix}note: ${note}`) : []),
  ];
}

function renderInputSection(payload: PlatformSchemaDocument): ReadonlyArray<string> {
  const lines: Array<string> = [];

  function pushGroupedChannel(
    flag: string,
    options: {
      readonly requiredLines?: ReadonlyArray<string>;
      readonly optionalLines?: ReadonlyArray<string>;
      readonly guidanceLines?: ReadonlyArray<string>;
    },
  ) {
    const requiredLines = options.requiredLines ?? [];
    const optionalLines = options.optionalLines ?? [];
    const guidanceLines = options.guidanceLines ?? [];
    if (requiredLines.length === 0 && optionalLines.length === 0 && guidanceLines.length === 0) {
      return;
    }

    lines.push(`  ${flag}`);
    lines.push(...requiredLines, ...optionalLines);
    lines.push(...guidanceLines);
  }

  function pushSchemaChannel(
    flag: string,
    options: {
      readonly schemaLines?: ReadonlyArray<string>;
      readonly guidanceLines?: ReadonlyArray<string>;
    },
  ) {
    const schemaLines = options.schemaLines ?? [];
    const guidanceLines = options.guidanceLines ?? [];
    if (schemaLines.length === 0 && guidanceLines.length === 0) {
      return;
    }

    lines.push(`  ${flag}`);
    lines.push(...schemaLines);
    lines.push(...guidanceLines);
  }

  const params = payload.input.params;
  if (params) {
    pushGroupedChannel(params.flag, {
      requiredLines: hasFieldGroups(params, "required")
        ? renderFieldGroup(params, "required", 4)
        : [],
      optionalLines: hasFieldGroups(params, "optional")
        ? renderFieldGroup(params, "optional", 4)
        : [],
      guidanceLines: params.guidance ? [`      hint: ${params.guidance}`] : [],
    });
  }

  const body = payload.input.body;
  const channels = body?.channels;
  const guidanceTarget =
    channels?.upload !== undefined
      ? "upload"
      : channels?.body !== undefined
        ? "body"
        : channels?.json !== undefined
          ? "json"
          : undefined;
  const guidanceMode = shouldRenderBodyGuidance(payload);

  for (const key of ["json", "upload", "body"] as const) {
    const channel = channels?.[key];
    if (channel === undefined) {
      continue;
    }

    const guidanceLines =
      guidanceTarget === key
        ? renderGuidanceLines(body?.guidance, {
            indent: 6,
            includeSummary: guidanceMode.includeSummary,
            includeNotes: guidanceMode.includeNotes,
          })
        : [];

    const requiredLines = hasFieldGroups(channel, "required")
      ? renderFieldGroup(channel, "required", 4)
      : [];
    const optionalLines = hasFieldGroups(channel, "optional")
      ? renderFieldGroup(channel, "optional", 4)
      : [];

    if (requiredLines.length > 0 || optionalLines.length > 0) {
      pushGroupedChannel(channel.flag, {
        requiredLines,
        optionalLines,
        guidanceLines,
      });
      continue;
    }

    const schemaLines =
      channel.schema !== undefined ? renderChannelSchema(channel, !body?.required, 4) : [];
    pushSchemaChannel(channel.flag, {
      schemaLines,
      guidanceLines,
    });
  }

  return lines;
}

function renderResponseSection(response: ApiSchema | undefined): ReadonlyArray<string> {
  if (response === undefined) {
    return ["  No response schema available."];
  }

  if (
    "type" in response &&
    response.type === "object" &&
    response.properties &&
    Object.keys(response.properties).length > 0
  ) {
    return orderedObjectEntries(response).flatMap(([name, schema, required]) =>
      renderResponseNamedSchema(name, schema, 2, { optional: !required }),
    );
  }

  return renderResponseNamedSchema("result", response, 2, { optional: false });
}

function getExamplesTitle(
  examples: ReadonlyArray<{ readonly description: string; readonly command: string }>,
): string {
  return examples.length === 1 ? "Example" : "Examples";
}

function renderExamplesSection(
  examples: ReadonlyArray<{ readonly description: string; readonly command: string }>,
): ReadonlyArray<string> {
  if (examples.length === 0) {
    return ["  No examples available."];
  }

  if (examples.length === 1) {
    return [`  ${examples[0]!.command}`];
  }

  return examples.flatMap((example) => [`  ${example.description}`, `    ${example.command}`]);
}

function renderProjectionSection(
  projection: PlatformSchemaDocument["projection"],
): ReadonlyArray<string> {
  if (projection.available.length === 0) {
    return ["  No --fields projection is available."];
  }

  return [`  ${projection.flag} ${projection.available.join(",")}`];
}

function renderSection(title: string, lines: ReadonlyArray<string>): string {
  return `${title}\n${lines.join("\n")}`;
}

function getRouteDescriptionLines(
  payload: Pick<PlatformSchemaDocument, "summary" | "description">,
): ReadonlyArray<string> {
  if (payload.summary.length === 0) {
    return payload.description.length > 0 ? [payload.description] : [];
  }

  if (payload.description.length === 0) {
    return [payload.summary];
  }

  if (payload.description === payload.summary || payload.description.startsWith(payload.summary)) {
    return [payload.description];
  }

  return [payload.summary, payload.description];
}

export function renderPlatformSchemaPayload(payload: PlatformSchemaDocument): string {
  const input = renderInputSection(payload);
  const descriptionLines = getRouteDescriptionLines(payload);

  const sections = [
    renderSection("Route", [
      `  ${payload.method} ${payload.route}`,
      ...descriptionLines.map((line) => `  ${line}`),
    ]),
    renderSection("Input", input.length > 0 ? input : ["  None."]),
    renderSection(getExamplesTitle(payload.examples), renderExamplesSection(payload.examples)),
    renderSection("Returns", renderResponseSection(payload.response)),
    renderSection("Available --fields", renderProjectionSection(payload.projection)),
  ];

  return sections.join("\n\n");
}

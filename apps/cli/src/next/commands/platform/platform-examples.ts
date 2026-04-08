import type {
  PlatformGeneratedExamples,
  PlatformInputHelp,
  PlatformInputHelpBody,
  PlatformInputHelpExample,
  PlatformOperationDescriptor,
  PlatformSchemaNode,
} from "./platform-types.ts";
import { formatPlatformApiCommand } from "./platform-cli.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const PARAM_PLACEHOLDERS: Record<string, string | boolean | number> = {
  ref: "project-ref",
  slug: "my-function",
  function_slug: "my-function",
  branch_id_or_ref: "branch-ref",
  id: "resource-id",
  name: "example-name",
};

const SENSITIVE_PLACEHOLDER = "<redacted>";

const bodyExampleOverrides: Partial<
  Record<PlatformOperationDescriptor["operationId"], ReadonlyArray<PlatformInputHelpExample>>
> = {
  v1ExchangeOauthToken: [
    {
      description:
        "Pass structured fields with `--json` and let the CLI serialize them as form data.",
      command:
        'supabase api request /v1/oauth/token --method POST --json \'{"grant_type":"refresh_token","refresh_token":"refresh-token"}\'',
    },
  ],
};

function shellQuoteSingle(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatJsonForShell(value: JsonValue): string {
  return shellQuoteSingle(JSON.stringify(value));
}

function placeholderForField(node: PlatformSchemaNode, includeOptionalBinary: boolean): JsonValue {
  if (node.name && PARAM_PLACEHOLDERS[node.name] !== undefined) {
    return PARAM_PLACEHOLDERS[node.name] as JsonValue;
  }
  if (node.sensitive) {
    return SENSITIVE_PLACEHOLDER;
  }
  if (node.enumValues && node.enumValues.length > 0) {
    return node.enumValues[0]!;
  }

  switch (node.kind) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return 1;
    case "string":
      if (node.format === "binary") {
        return `./${node.name ?? "file"}.bin`;
      }
      if (node.format === "uuid") {
        return "00000000-0000-0000-0000-000000000000";
      }
      if (node.format === "uri") {
        return "https://example.com/resource";
      }
      return node.name && PARAM_PLACEHOLDERS[node.name] === undefined
        ? `${node.name}-value`
        : "example-value";
    case "enum":
      return node.enumValues?.[0] ?? "example";
    case "array": {
      if (!node.items) {
        return [];
      }
      return [exampleValueForNode(node.items, true, includeOptionalBinary)];
    }
    case "object":
      return objectExampleForNode(node, true, includeOptionalBinary);
    case "union": {
      const firstVariant = node.variants?.[0];
      return firstVariant
        ? exampleValueForNode(firstVariant, true, includeOptionalBinary)
        : "example-value";
    }
    case "unknown":
      return "example-value";
  }
}

function objectExampleForNode(
  node: PlatformSchemaNode,
  includeOptional: boolean,
  includeOptionalBinary: boolean,
): JsonValue {
  const properties = node.properties ?? [];
  const entries = properties.flatMap((property) => {
    if (!property.name) {
      return [];
    }
    if (!property.required && !includeOptional) {
      const isBinaryProperty =
        property.format === "binary" ||
        (property.kind === "array" && property.items?.format === "binary");
      if (!(includeOptionalBinary && isBinaryProperty)) {
        return [];
      }
    }
    return [
      [
        property.name,
        exampleValueForNode(property, includeOptional, includeOptionalBinary),
      ] as const,
    ];
  });
  return Object.fromEntries(entries);
}

function exampleValueForNode(
  node: PlatformSchemaNode,
  includeOptional: boolean,
  includeOptionalBinary: boolean,
): JsonValue {
  if (node.kind === "object") {
    return objectExampleForNode(node, includeOptional, includeOptionalBinary);
  }
  return placeholderForField(node, includeOptionalBinary);
}

function buildParamsExampleValue(
  descriptor: PlatformOperationDescriptor,
): Record<string, JsonValue> | undefined {
  const requiredParams = descriptor.request.params.filter((field) => field.required && field.name);
  if (requiredParams.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    requiredParams.map((field) => [field.name!, exampleValueForNode(field, false, false)] as const),
  );
}

function buildJsonBodyExample(schema: PlatformSchemaNode | undefined): JsonValue | undefined {
  if (!schema) {
    return undefined;
  }

  if (schema.kind === "object") {
    const requiredOnly = objectExampleForNode(schema, false, false);
    if (!isEmptyObject(requiredOnly)) {
      return requiredOnly;
    }

    const fallbackEntries =
      schema.properties
        ?.filter((property) => property.name)
        .slice(0, 3)
        .map(
          (property) => [property.name!, exampleValueForNode(property, false, false)] as const,
        ) ?? [];

    return Object.fromEntries(fallbackEntries);
  }

  return exampleValueForNode(schema, false, false);
}

function buildMultipartBodyExample(schema: PlatformSchemaNode | undefined): JsonValue | undefined {
  if (!schema) {
    return undefined;
  }

  if (schema.kind === "object") {
    return objectExampleForNode(schema, false, false);
  }

  return exampleValueForNode(schema, false, false);
}

function multipartUploadSegments(schema: PlatformSchemaNode | undefined): ReadonlyArray<string> {
  return (
    schema?.properties?.flatMap((property) => {
      if (!property.name) {
        return [];
      }
      if (property.format === "binary") {
        return [`--upload ${property.name}=./${property.name}.bin`];
      }
      if (property.kind === "array" && property.items?.format === "binary") {
        return [
          `--upload ${property.name}=./${property.name}-1.bin`,
          `--upload ${property.name}=./${property.name}-2.bin`,
        ];
      }
      return [];
    }) ?? []
  );
}

function isEmptyObject(value: JsonValue | undefined): boolean {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function buildBodyExamples(
  descriptor: PlatformOperationDescriptor,
): ReadonlyArray<PlatformInputHelpExample> {
  const override = bodyExampleOverrides[descriptor.operationId];
  if (override) {
    return override;
  }

  const baseCommand = formatPlatformApiCommand(descriptor);
  const paramsExample = buildParamsExampleValue(descriptor);
  const paramsSegment = paramsExample ? ` --params ${formatJsonForShell(paramsExample)}` : "";

  switch (descriptor.request.body.kind) {
    case "none":
      return [];
    case "json": {
      const example = buildJsonBodyExample(descriptor.request.body.schema);
      if (example === undefined) {
        return [];
      }

      const flag = descriptor.request.body.schema?.kind === "object" ? "--json" : "--body";
      return [
        {
          description:
            flag === "--json"
              ? "Pass the required JSON fields with `--json`."
              : "Pass the request payload with `--body`.",
          command: `${baseCommand}${paramsSegment} ${flag} ${formatJsonForShell(example)}`,
        },
      ];
    }
    case "binary":
      return [
        {
          description: "Read raw bytes from a file.",
          command: `${baseCommand}${paramsSegment} --body-file ./body.bin`,
        },
        {
          description: "Read raw bytes from stdin.",
          command: `cat ./body.bin | ${baseCommand}${paramsSegment} --body -`,
        },
      ];
    case "multipart": {
      const structuredExample = buildMultipartBodyExample(descriptor.request.body.schema);
      const uploadSegments = multipartUploadSegments(descriptor.request.body.schema);
      const structuredSegment =
        structuredExample === undefined || isEmptyObject(structuredExample)
          ? ""
          : ` --json ${formatJsonForShell(structuredExample)}`;

      if (structuredSegment.length === 0 && uploadSegments.length === 0) {
        return [];
      }
      return [
        {
          description:
            "Pass structured multipart fields with `--json` and binary parts with `--upload`.",
          command: `${baseCommand}${paramsSegment}${structuredSegment}${uploadSegments.length > 0 ? ` ${uploadSegments.join(" ")}` : ""}`,
        },
      ];
    }
    case "urlencoded": {
      const example = buildJsonBodyExample(descriptor.request.body.schema);
      if (example === undefined || Array.isArray(example) || typeof example !== "object") {
        return [];
      }
      return [
        {
          description:
            "Pass structured fields with `--json` and let the CLI serialize them as form data.",
          command: `${baseCommand}${paramsSegment} --json ${formatJsonForShell(example)}`,
        },
      ];
    }
  }
}

function buildCommandExamples(
  descriptor: PlatformOperationDescriptor,
): ReadonlyArray<PlatformInputHelpExample> {
  const bodyExamples = buildBodyExamples(descriptor);
  if (bodyExamples.length > 0) {
    return bodyExamples;
  }

  const baseCommand = formatPlatformApiCommand(descriptor);
  const paramsExample = buildParamsExampleValue(descriptor);

  if (paramsExample) {
    return [
      {
        description: "Pass the required path, query, or header input with `--params`.",
        command: `${baseCommand} --params ${formatJsonForShell(paramsExample)}`,
      },
    ];
  }

  return [
    {
      description: "Run the command with no additional input.",
      command: baseCommand,
    },
  ];
}

function buildBodyInputHelp(
  descriptor: PlatformOperationDescriptor,
  examples: ReadonlyArray<PlatformInputHelpExample>,
): PlatformInputHelpBody | undefined {
  switch (descriptor.request.body.kind) {
    case "none":
      return undefined;
    case "json":
      if (descriptor.request.body.schema?.kind === "object") {
        return {
          summary: "Use `--json` for object-shaped JSON request bodies.",
          notes: ["Pass inline JSON or `-` to read JSON from stdin."],
          ...(examples.length > 0 ? { examples } : {}),
        };
      }
      return {
        summary: "Use `--body` for JSON arrays, scalars, or other non-object JSON request bodies.",
        notes: ["Pass inline JSON or `-` to read JSON from stdin."],
        ...(examples.length > 0 ? { examples } : {}),
      };
    case "binary":
      return {
        summary: "This request body expects raw bytes.",
        notes: [
          "Use `--body-file <path>` to read bytes from a filesystem path.",
          "Use `--body -` to read bytes from stdin.",
          "Inline `--body some-text` is UTF-8 encoded before being sent, but `--body-file` is the normal form for binary payloads.",
        ],
        ...(examples.length > 0 ? { examples } : {}),
      };
    case "multipart":
      return {
        summary:
          "This request body expects structured fields via `--json` and binary fields via `--upload`.",
        notes: [
          "Use `--json` for structured multipart fields such as `metadata`.",
          "Use repeated `--upload field=path` flags for binary multipart fields, including array-valued fields.",
        ],
        ...(examples.length > 0 ? { examples } : {}),
      };
    case "urlencoded":
      return {
        summary: "This request body expects structured fields passed to `--json`.",
        notes: ["Pass an object with `--json`; the CLI serializes it as urlencoded form data."],
        ...(examples.length > 0 ? { examples } : {}),
      };
  }
}

function buildInputHelp(
  descriptor: PlatformOperationDescriptor,
  bodyExamples: ReadonlyArray<PlatformInputHelpExample>,
): PlatformInputHelp | undefined {
  const body = buildBodyInputHelp(descriptor, bodyExamples);
  const params =
    descriptor.request.params.length > 0
      ? "Use `--params` with inline JSON or `-` to read JSON from stdin."
      : undefined;

  if (params === undefined && body === undefined) {
    return undefined;
  }

  return {
    ...(params ? { params } : {}),
    ...(body ? { body } : {}),
  };
}

export function buildPlatformGeneratedExamples(
  descriptor: PlatformOperationDescriptor,
): PlatformGeneratedExamples {
  const bodyExamples = buildBodyExamples(descriptor);
  const commandExamples = buildCommandExamples(descriptor);
  const inputHelp = buildInputHelp(descriptor, bodyExamples);

  return {
    ...(inputHelp ? { inputHelp } : {}),
    commandExamples,
  };
}

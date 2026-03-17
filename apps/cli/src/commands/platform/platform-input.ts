import { Effect, FileSystem, Option, Schema } from "effect";

import { NonInteractiveError } from "../../output/errors.ts";
import { Output } from "../../output/output.service.ts";
import { Stdin } from "../../runtime/stdin.service.ts";
import { PlatformInputError } from "./platform.errors.ts";
import type {
  PlatformOperationDescriptor,
  PlatformRequestBodyDescriptor,
  PlatformSchemaNode,
} from "./platform-types.ts";

type JsonRecord = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const textEncoder = new TextEncoder();
type MultipartUploadKind = "single" | "array";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatSourceLabel = (kind: "json" | "params") => (kind === "json" ? "--json" : "--params");

const formatPlatformMethod = (descriptor: PlatformOperationDescriptor): string =>
  descriptor.commandPath.slice(1).join(".");

const invalidJsonInput = (kind: "json" | "params", detail: string) =>
  new PlatformInputError({
    message: `Invalid ${formatSourceLabel(kind)} payload.`,
    detail,
    suggestion: `Pass an inline JSON object or - for stdin to ${formatSourceLabel(kind)}.`,
  });

const toPlatformInputError = (
  cause: unknown,
  fallback: () => PlatformInputError,
): PlatformInputError => (cause instanceof PlatformInputError ? cause : fallback());

const parseJsonRecord = (
  raw: string,
  kind: "json" | "params",
): Effect.Effect<JsonRecord, PlatformInputError> =>
  Effect.try({
    try: () => JSON.parse(raw),
    catch: (cause) =>
      invalidJsonInput(kind, cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.flatMap((value) =>
      isRecord(value)
        ? Effect.succeed(value)
        : Effect.fail(
            invalidJsonInput(kind, `${formatSourceLabel(kind)} must decode to a JSON object.`),
          ),
    ),
  );

const readJsonSource = (
  raw: string,
  kind: "json" | "params",
): Effect.Effect<JsonRecord, PlatformInputError, Stdin> =>
  Effect.gen(function* () {
    const stdin = yield* Stdin;

    if (raw === "-") {
      const piped = yield* stdin.readPipedText;
      if (Option.isNone(piped)) {
        return yield* Effect.fail(
          invalidJsonInput(
            kind,
            `No piped stdin content was available for ${formatSourceLabel(kind)}.`,
          ),
        );
      }
      return yield* parseJsonRecord(piped.value, kind);
    }

    return yield* parseJsonRecord(raw, kind);
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        toPlatformInputError(cause, () =>
          invalidJsonInput(kind, cause instanceof Error ? cause.message : String(cause)),
        ),
      ),
    ),
  );

export const parsePlatformJsonSource = (
  raw: Option.Option<string>,
  kind: "json" | "params",
): Effect.Effect<Option.Option<JsonRecord>, PlatformInputError, Stdin> =>
  Effect.gen(function* () {
    if (Option.isNone(raw)) {
      return Option.none<JsonRecord>();
    }

    const parsed = yield* readJsonSource(raw.value, kind);
    return Option.some(parsed);
  });

export function validatePlatformStdinUsage(
  json: Option.Option<string>,
  params: Option.Option<string>,
  body: Option.Option<string>,
  uploads: ReadonlyArray<string>,
): Effect.Effect<void, PlatformInputError> {
  const stdinFlags = [json, params, body].filter(
    (value): value is Option.Some<string> => Option.isSome(value) && value.value === "-",
  );
  const stdinUploads = uploads.filter((upload) => {
    const separatorIndex = upload.indexOf("=");
    return separatorIndex > 0 && upload.slice(separatorIndex + 1) === "-";
  });

  if (stdinFlags.length + stdinUploads.length > 1) {
    return Effect.fail(
      new PlatformInputError({
        message:
          "Only one of --json, --params, --body, or --upload can read from stdin in the same command.",
        suggestion:
          "Use stdin for one input source and inline content or file paths for the others.",
      }),
    );
  }

  return Effect.void;
}

const getPropertyNames = (node: PlatformSchemaNode | undefined): ReadonlyArray<string> =>
  node?.properties?.flatMap((property) => (property.name ? [property.name] : [])) ?? [];

function unsupportedJsonSuggestion(descriptor: PlatformOperationDescriptor): string {
  if (descriptor.request.body.kind === "none") {
    return "Use `--params` for path, query, or header input.";
  }
  if (descriptor.request.body.kind === "binary") {
    return "Use `--body`, `--body-file`, or `--body -` for raw request bodies.";
  }

  return "Use `--body` for non-object request bodies.";
}

function isBinaryNode(node: PlatformSchemaNode | undefined): boolean {
  return node?.format === "binary";
}

function isBinaryArrayNode(node: PlatformSchemaNode | undefined): boolean {
  return node?.kind === "array" && node.items?.format === "binary";
}

function isMultipartBinaryField(node: PlatformSchemaNode | undefined): boolean {
  return isBinaryNode(node) || isBinaryArrayNode(node);
}

const validateInputKeys = (
  descriptor: PlatformOperationDescriptor,
  value: JsonRecord,
  allowed: ReadonlyArray<string>,
  kind: "json" | "params",
): Effect.Effect<void, PlatformInputError> => {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length === 0) {
    return Effect.void;
  }

  return Effect.fail(
    new PlatformInputError({
      message: `Unexpected field(s) in ${formatSourceLabel(kind)}.`,
      detail: unknown.join(", "),
      suggestion: `Run \`supabase platform schema ${formatPlatformMethod(descriptor)}\` or re-run \`supabase ${descriptor.commandPath.join(" ")} --schema\` to inspect the supported request shape.`,
    }),
  );
};

export function mergePlatformInput(options: {
  readonly descriptor: PlatformOperationDescriptor;
  readonly jsonValues: Option.Option<JsonRecord>;
  readonly paramsValues: Option.Option<JsonRecord>;
  readonly bodyValue: Option.Option<unknown>;
  readonly uploadValues: Option.Option<JsonRecord>;
}): Effect.Effect<JsonRecord, PlatformInputError> {
  const bodySchema = options.descriptor.request.body.schema;
  const structuredBodyKind = options.descriptor.request.body.kind;
  const expectsStructuredJsonBody =
    (structuredBodyKind === "json" && bodySchema?.kind === "object") ||
    structuredBodyKind === "multipart" ||
    structuredBodyKind === "urlencoded";
  const bodyFieldNames =
    structuredBodyKind === "multipart"
      ? (bodySchema?.properties
          ?.filter((property) => property.name && !isMultipartBinaryField(property))
          .map((property) => property.name!) ?? [])
      : expectsStructuredJsonBody
        ? getPropertyNames(bodySchema)
        : [];
  const paramsFieldNames = options.descriptor.request.params.flatMap((field) =>
    field.name ? [field.name] : [],
  );

  return Effect.gen(function* () {
    if (Option.isSome(options.jsonValues)) {
      if (!expectsStructuredJsonBody) {
        return yield* Effect.fail(
          new PlatformInputError({
            message: `This command does not accept ${formatSourceLabel("json")}.`,
            suggestion: unsupportedJsonSuggestion(options.descriptor),
          }),
        );
      }
      yield* validateInputKeys(
        options.descriptor,
        options.jsonValues.value,
        bodyFieldNames,
        "json",
      );
    }
    if (Option.isSome(options.paramsValues)) {
      yield* validateInputKeys(
        options.descriptor,
        options.paramsValues.value,
        paramsFieldNames,
        "params",
      );
    }

    const bodyFieldName = options.descriptor.request.body.fieldName;

    if (structuredBodyKind === "json" && bodySchema?.kind === "object") {
      return {
        ...(Option.isSome(options.paramsValues) ? options.paramsValues.value : {}),
        ...(Option.isSome(options.jsonValues) ? options.jsonValues.value : {}),
      };
    }

    if (structuredBodyKind === "multipart") {
      const multipartBody = {
        ...(Option.isSome(options.jsonValues) ? options.jsonValues.value : {}),
        ...(Option.isSome(options.uploadValues) ? options.uploadValues.value : {}),
      };

      return {
        ...(Option.isSome(options.paramsValues) ? options.paramsValues.value : {}),
        ...(bodyFieldName !== undefined && Object.keys(multipartBody).length > 0
          ? { [bodyFieldName]: multipartBody }
          : {}),
      };
    }

    if (structuredBodyKind === "urlencoded") {
      return {
        ...(Option.isSome(options.paramsValues) ? options.paramsValues.value : {}),
        ...(bodyFieldName !== undefined && Option.isSome(options.jsonValues)
          ? { [bodyFieldName]: options.jsonValues.value }
          : {}),
      };
    }

    const mergedBody =
      Option.isSome(options.bodyValue) && bodyFieldName !== undefined
        ? { [bodyFieldName]: options.bodyValue.value }
        : {};

    return {
      ...(Option.isSome(options.paramsValues) ? options.paramsValues.value : {}),
      ...mergedBody,
    };
  });
}

const requireInteractivePrompts = Effect.gen(function* () {
  const output = yield* Output;
  const stdin = yield* Stdin;

  if (output.format !== "text" || !stdin.isTTY) {
    return yield* Effect.fail(
      new NonInteractiveError({
        detail: "Cannot prompt for missing platform request fields in non-interactive mode.",
        suggestion: "Provide all required values with --json or --params.",
      }),
    );
  }

  return output;
});

function isNodeRequired(node: PlatformSchemaNode): boolean {
  return node.required && !node.nullable;
}

function promptLabel(node: PlatformSchemaNode): string {
  return node.label ?? node.name ?? "Value";
}

const promptForField = (
  field: PlatformSchemaNode,
): Effect.Effect<unknown, NonInteractiveError, Output | Stdin> =>
  Effect.gen(function* () {
    const output = yield* requireInteractivePrompts;
    const label = promptLabel(field);

    switch (field.kind) {
      case "boolean":
        return yield* output.promptConfirm(`${label}?`);
      case "enum":
        return yield* output.promptSelect(
          label,
          (field.enumValues ?? []).map((value) => ({ value, label: value })),
        );
      case "array":
      case "object":
      case "union":
      case "unknown": {
        const raw = yield* output.promptText(`${label} (JSON)`, {
          validate: (value) => {
            if (!value.trim()) {
              return isNodeRequired(field) ? `${label} is required` : undefined;
            }
            try {
              JSON.parse(value);
            } catch (cause) {
              return cause instanceof Error ? cause.message : "Invalid JSON";
            }
          },
        });
        return JSON.parse(raw);
      }
      case "integer":
      case "number": {
        const raw = yield* output.promptText(label, {
          validate: (value) => {
            if (!value.trim()) {
              return isNodeRequired(field) ? `${label} is required` : undefined;
            }
            return Number.isNaN(Number(value)) ? `${label} must be a number` : undefined;
          },
        });
        return Number(raw);
      }
      case "string":
      default:
        if (field.sensitive) {
          return yield* output.promptPassword(label);
        }
        return yield* output.promptText(label, {
          validate: (value) =>
            isNodeRequired(field) && value.trim().length === 0 ? `${label} is required` : undefined,
        });
    }
  });

function topLevelPromptFields(
  descriptor: PlatformOperationDescriptor,
): ReadonlyArray<PlatformSchemaNode> {
  const params = descriptor.request.params.filter((field) => field.name !== undefined);
  const body = descriptor.request.body;

  if (body.kind !== "json" || body.schema?.kind !== "object") {
    return params;
  }

  return [
    ...params,
    ...(body.schema.properties?.filter((field) => field.name !== undefined) ?? []),
  ];
}

export const promptForMissingPlatformFields = (
  descriptor: PlatformOperationDescriptor,
  input: JsonRecord,
): Effect.Effect<JsonRecord, NonInteractiveError, Output | Stdin> =>
  Effect.gen(function* () {
    const completed = { ...input };

    for (const field of topLevelPromptFields(descriptor).filter(isNodeRequired)) {
      if (field.name === undefined || completed[field.name] !== undefined) {
        continue;
      }
      completed[field.name] = yield* promptForField(field);
    }

    return completed;
  });

export const decodePlatformInput = <S extends Schema.Top & { readonly DecodingServices: never }>(
  descriptor: PlatformOperationDescriptor,
  schema: S,
  input: JsonRecord,
): Effect.Effect<S["Type"], PlatformInputError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new PlatformInputError({
        message: "The request payload does not match the operation schema.",
        detail: cause instanceof Error ? cause.message : String(cause),
        suggestion: `Run \`supabase platform schema ${formatPlatformMethod(descriptor)}\` or re-run \`supabase ${descriptor.commandPath.join(" ")} --schema\` to inspect the documented request and response shape.`,
      }),
  });

function interpolatePath(pathTemplate: string, input: JsonRecord): string {
  return pathTemplate.replaceAll(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = input[key];
    return value === undefined ? `{${key}}` : encodeURIComponent(String(value));
  });
}

function containsSensitiveNode(node: PlatformSchemaNode | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  if (node.sensitive) {
    return true;
  }
  return (
    (node.properties?.some(containsSensitiveNode) ?? false) ||
    (node.items ? containsSensitiveNode(node.items) : false) ||
    (node.variants?.some(containsSensitiveNode) ?? false)
  );
}

function redactNode(node: PlatformSchemaNode | undefined, value: unknown): unknown {
  if (value === undefined || node === undefined) {
    return value;
  }
  if (node.sensitive) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactNode(node.items, entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const properties = node.properties;
  if (properties === undefined || properties.length === 0) {
    return value;
  }
  const byName = new Map(
    properties.flatMap((property) => (property.name ? [[property.name, property] as const] : [])),
  );
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactNode(byName.get(key), entry)]),
  );
}

export function redactPlatformInputForPreview(
  descriptor: PlatformOperationDescriptor,
  input: JsonRecord,
): JsonRecord {
  const preview: JsonRecord = {};
  const paramsByName = new Map(
    descriptor.request.params.flatMap((field) =>
      field.name ? [[field.name, field] as const] : [],
    ),
  );

  for (const [key, value] of Object.entries(input)) {
    if (paramsByName.has(key)) {
      preview[key] = redactNode(paramsByName.get(key), value);
      continue;
    }
    if (key === descriptor.request.body.fieldName) {
      preview[key] = containsSensitiveNode(descriptor.request.body.schema)
        ? redactNode(descriptor.request.body.schema, value)
        : value;
      continue;
    }
    const bodyProperty = descriptor.request.body.schema?.properties?.find(
      (property) => property.name === key,
    );
    preview[key] = redactNode(bodyProperty, value);
  }

  return preview;
}

export function buildPlatformRequestPreview(
  descriptor: PlatformOperationDescriptor,
  input: JsonRecord,
): JsonRecord {
  const params: JsonRecord = {};
  const json: JsonRecord = {};
  const bodyFieldName = descriptor.request.body.fieldName;

  for (const field of descriptor.request.params) {
    if (field.name === undefined) {
      continue;
    }
    const value = input[field.name];
    if (value === undefined) {
      continue;
    }
    params[field.name] = value;
  }

  if (
    descriptor.request.body.kind === "json" &&
    descriptor.request.body.schema?.kind === "object"
  ) {
    for (const field of descriptor.request.body.schema.properties ?? []) {
      if (field.name === undefined) {
        continue;
      }
      const value = input[field.name];
      if (value !== undefined) {
        json[field.name] = value;
      }
    }
  }

  const previewBody =
    bodyFieldName !== undefined && input[bodyFieldName] !== undefined
      ? input[bodyFieldName]
      : undefined;

  return {
    operation: descriptor.operationId,
    method: descriptor.method,
    path: interpolatePath(descriptor.path, input),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(json).length > 0 ? { json } : {}),
    ...(previewBody !== undefined
      ? {
          body: previewBody,
          bodyKind: descriptor.request.body.kind,
          ...(descriptor.request.body.contentType
            ? { contentType: descriptor.request.body.contentType }
            : {}),
        }
      : {}),
  };
}

function invalidBodyInput(detail: string, suggestion: string) {
  return new PlatformInputError({
    message: "Invalid request body input.",
    detail,
    suggestion,
  });
}

function parseJsonValue(raw: string): Effect.Effect<JsonValue, PlatformInputError> {
  return Effect.try({
    try: () => JSON.parse(raw) as JsonValue,
    catch: (cause) =>
      invalidBodyInput(
        cause instanceof Error ? cause.message : String(cause),
        "Pass inline JSON or - for stdin to --body.",
      ),
  });
}

function readBodyText(raw: string): Effect.Effect<string, PlatformInputError, Stdin> {
  return Effect.gen(function* () {
    const stdin = yield* Stdin;

    if (raw === "-") {
      const piped = yield* stdin.readPipedText;
      if (Option.isNone(piped)) {
        return yield* Effect.fail(
          invalidBodyInput(
            "No piped stdin content was available for --body.",
            "Provide inline content or piped stdin to --body.",
          ),
        );
      }
      return piped.value;
    }

    return raw;
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        toPlatformInputError(cause, () =>
          invalidBodyInput(
            cause instanceof Error ? cause.message : String(cause),
            "Pass inline content or - for stdin to --body.",
          ),
        ),
      ),
    ),
  );
}

function readBodyFileText(
  filePath: string,
): Effect.Effect<string, PlatformInputError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath);
    if (!exists) {
      return yield* Effect.fail(
        invalidBodyInput(`File not found: ${filePath}`, "Check the path passed to --body-file."),
      );
    }
    return yield* fs.readFileString(filePath);
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        toPlatformInputError(cause, () =>
          invalidBodyInput(
            cause instanceof Error ? cause.message : String(cause),
            "Pass a readable file path to --body-file.",
          ),
        ),
      ),
    ),
  );
}

function readBodyFileBytes(
  filePath: string,
): Effect.Effect<Uint8Array, PlatformInputError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath);
    if (!exists) {
      return yield* Effect.fail(
        invalidBodyInput(`File not found: ${filePath}`, "Check the path passed to --body-file."),
      );
    }
    return yield* fs.readFile(filePath);
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        toPlatformInputError(cause, () =>
          invalidBodyInput(
            cause instanceof Error ? cause.message : String(cause),
            "Pass a readable file path to --body-file.",
          ),
        ),
      ),
    ),
  );
}

function parseBinaryBody(raw: string): Effect.Effect<Uint8Array, PlatformInputError, Stdin> {
  return Effect.gen(function* () {
    const stdin = yield* Stdin;

    if (raw === "-") {
      const piped = yield* stdin.readPipedBytes;
      if (Option.isNone(piped)) {
        return yield* Effect.fail(
          invalidBodyInput(
            "No piped stdin content was available for --body.",
            "This request expects raw bytes. Provide `--body-file <path>` or pipe bytes to `--body -`.",
          ),
        );
      }
      return piped.value;
    }

    return textEncoder.encode(raw);
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        toPlatformInputError(cause, () =>
          invalidBodyInput(
            cause instanceof Error ? cause.message : String(cause),
            "This request expects raw bytes. Use `--body-file <path>`, `--body -`, or inline text if you want UTF-8 bytes.",
          ),
        ),
      ),
    ),
  );
}

function parseNonObjectJsonBody(raw: string): Effect.Effect<JsonValue, PlatformInputError, Stdin> {
  return Effect.gen(function* () {
    const text = yield* readBodyText(raw);
    return yield* parseJsonValue(text);
  });
}

function parseNonObjectJsonBodyFile(
  filePath: string,
): Effect.Effect<JsonValue, PlatformInputError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const text = yield* readBodyFileText(filePath);
    return yield* parseJsonValue(text);
  });
}

export const parsePlatformBodySource = (
  raw: {
    readonly body: Option.Option<string>;
    readonly bodyFile: Option.Option<string>;
  },
  descriptor: PlatformRequestBodyDescriptor,
): Effect.Effect<Option.Option<unknown>, PlatformInputError, FileSystem.FileSystem | Stdin> =>
  Effect.gen(function* () {
    if (Option.isSome(raw.body) && Option.isSome(raw.bodyFile)) {
      return yield* Effect.fail(
        invalidBodyInput(
          "Cannot use --body and --body-file together.",
          "Choose one raw body source and retry.",
        ),
      );
    }

    if (Option.isNone(raw.body) && Option.isNone(raw.bodyFile)) {
      return Option.none();
    }

    if (descriptor.kind === "none") {
      return yield* Effect.fail(
        invalidBodyInput(
          "This command does not accept raw request body input.",
          "Remove --body and --body-file and retry.",
        ),
      );
    }

    if (descriptor.kind === "json" && descriptor.schema?.kind === "object") {
      return yield* Effect.fail(
        invalidBodyInput(
          "This command expects an object JSON body.",
          "Use --json for object-shaped JSON request bodies.",
        ),
      );
    }

    if (descriptor.kind === "multipart") {
      return yield* Effect.fail(
        invalidBodyInput(
          "This command expects multipart input split across --json and --upload.",
          "Use --json for structured fields and --upload field=path for binary fields.",
        ),
      );
    }

    if (descriptor.kind === "urlencoded") {
      return yield* Effect.fail(
        invalidBodyInput(
          "This command expects structured form fields.",
          "Use --json for object-shaped request bodies. The CLI serializes them as urlencoded form data.",
        ),
      );
    }

    if (descriptor.kind === "binary") {
      if (Option.isSome(raw.bodyFile)) {
        return Option.some(yield* readBodyFileBytes(raw.bodyFile.value));
      }
      if (Option.isNone(raw.body)) {
        return yield* Effect.fail(
          invalidBodyInput("Missing raw request body input.", "Provide --body or --body-file."),
        );
      }
      return Option.some(yield* parseBinaryBody(raw.body.value));
    }

    if (Option.isSome(raw.bodyFile)) {
      return Option.some(yield* parseNonObjectJsonBodyFile(raw.bodyFile.value));
    }
    if (Option.isNone(raw.body)) {
      return yield* Effect.fail(
        invalidBodyInput("Missing request body input.", "Provide --body or --body-file."),
      );
    }

    return Option.some(yield* parseNonObjectJsonBody(raw.body.value));
  });

function invalidUploadInput(detail: string, suggestion: string) {
  return new PlatformInputError({
    message: "Invalid --upload value.",
    detail,
    suggestion,
  });
}

function parseUploadSpec(
  raw: string,
): Effect.Effect<{ readonly field: string; readonly source: string }, PlatformInputError> {
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    return Effect.fail(
      invalidUploadInput(
        `Expected field=path, received: ${raw}`,
        "Use `--upload field=./path/to/file` or `--upload field=-`.",
      ),
    );
  }

  return Effect.succeed({
    field: raw.slice(0, separatorIndex),
    source: raw.slice(separatorIndex + 1),
  });
}

function readUploadBytes(
  field: string,
  source: string,
): Effect.Effect<Uint8Array, PlatformInputError, FileSystem.FileSystem | Stdin> {
  if (source === "-") {
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      const piped = yield* stdin.readPipedBytes;
      if (Option.isNone(piped)) {
        return yield* Effect.fail(
          invalidUploadInput(
            `No piped stdin content was available for multipart field "${field}".`,
            `Pipe bytes to stdin or pass a file path to --upload ${field}=...`,
          ),
        );
      }
      return piped.value;
    });
  }

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(source);
    if (!exists) {
      return yield* Effect.fail(
        invalidUploadInput(
          `File not found for multipart field "${field}": ${source}`,
          `Check the path passed to --upload ${field}=...`,
        ),
      );
    }
    return yield* fs.readFile(source);
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        toPlatformInputError(cause, () =>
          invalidUploadInput(
            cause instanceof Error ? cause.message : String(cause),
            `Check the path passed to --upload ${field}=...`,
          ),
        ),
      ),
    ),
  );
}

function multipartUploadKind(
  field: PlatformSchemaNode | undefined,
): MultipartUploadKind | undefined {
  if (isBinaryNode(field)) {
    return "single";
  }
  if (isBinaryArrayNode(field)) {
    return "array";
  }
  return undefined;
}

export const parsePlatformUploadSources = (
  raws: ReadonlyArray<string>,
  descriptor: PlatformRequestBodyDescriptor,
): Effect.Effect<Option.Option<JsonRecord>, PlatformInputError, FileSystem.FileSystem | Stdin> =>
  Effect.gen(function* () {
    if (raws.length === 0) {
      return Option.none<JsonRecord>();
    }

    if (descriptor.kind !== "multipart") {
      return yield* Effect.fail(
        invalidUploadInput(
          "This command does not accept --upload.",
          "Remove --upload and retry, or use --body-file for raw binary request bodies.",
        ),
      );
    }

    const properties = new Map(
      (descriptor.schema?.properties ?? [])
        .filter(
          (property): property is PlatformSchemaNode & { readonly name: string } =>
            typeof property.name === "string",
        )
        .map((property) => [property.name, property]),
    );

    const uploads: JsonRecord = {};

    for (const raw of raws) {
      const { field, source } = yield* parseUploadSpec(raw);
      const property = properties.get(field);
      const kind = multipartUploadKind(property);

      if (property === undefined) {
        return yield* Effect.fail(
          invalidUploadInput(
            `Unknown multipart upload field: ${field}`,
            "Run `supabase platform schema <method>` to inspect the multipart body shape.",
          ),
        );
      }

      if (kind === undefined) {
        return yield* Effect.fail(
          invalidUploadInput(
            `${field} is not a binary multipart field.`,
            "Use --json for structured multipart fields and --upload only for binary fields.",
          ),
        );
      }

      const value = yield* readUploadBytes(field, source);
      if (kind === "array") {
        const existing = uploads[field];
        uploads[field] = Array.isArray(existing) ? [...existing, value] : [value];
        continue;
      }

      if (uploads[field] !== undefined) {
        return yield* Effect.fail(
          invalidUploadInput(
            `Multipart field "${field}" only accepts a single upload.`,
            `Pass ${field}=... once, or use a repeated array-valued binary field if the schema supports it.`,
          ),
        );
      }
      uploads[field] = value;
    }

    return Option.some(uploads);
  });

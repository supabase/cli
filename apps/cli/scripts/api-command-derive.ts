import type { OperationId } from "@supabase/api/effect";
import { Cause, Exit, Predicate, Schema } from "effect";
import {
  verbVocabulary,
  type ApiCommandOverride,
  type ApiCommandPoll,
  type ApiNoun,
} from "../src/commands/api/api-command-overrides.ts";
import type {
  ApiCommandBinding,
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandSchemas,
  ApiCommandWait,
} from "../src/commands/api/api-command.model.ts";

type JsonObject = Readonly<Record<string, unknown>>;

/** Flags the generated-command runtime adds itself. */
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  "body",
  "file",
  "remote",
  "project-ref",
  "yes",
  "dry-run",
  "wait",
  "timeout",
  "output",
  "output-format",
  "experimental",
  "help",
]);

const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  "password",
  "secret",
  "token",
  "key",
  "private",
]);

const VERBS: ReadonlySet<string> = new Set(verbVocabulary);

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_COMMAND_WORDS = 4;
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;

export class ApiCommandGenerationError extends Schema.TaggedError<ApiCommandGenerationError>()(
  "ApiCommandGenerationError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.problems.map((problem) => `- ${problem}`).join("\n");
  }
}

const StatusMapping = {
  status: Schema.String,
  succeeded: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String),
};

interface XOperation {
  readonly group: string;
  readonly method: string;
  readonly poll?: ApiCommandPoll;
}

const XOperationSchema: Schema.Codec<XOperation> = Schema.Struct({
  group: Schema.String,
  method: Schema.String,
  poll: Schema.optionalKey(Schema.Struct(StatusMapping)),
});

const decodeXOperation = Schema.decodeUnknownExit(XOperationSchema, {
  onExcessProperty: "error",
});

interface DeriveInput {
  /** The parsed OpenAPI document. */
  readonly spec: JsonObject;
  /** Operation ids that generate commands; `x-operation` on any other operation is ignored. */
  readonly generated: ReadonlyArray<string>;
  /** Per-operation CLI metadata; its fields win over the spec's `x-operation`. */
  readonly overrides: Readonly<Record<string, ApiCommandOverride>>;
  readonly nouns: Readonly<Record<string, ApiNoun>>;
  /** Kebab-case operation id to the camelCase key of the typed client's `operationDefinitions`. */
  readonly operationIdMap: Readonly<Record<string, OperationId>>;
  /** Top-level command names owned by hand-written commands. */
  readonly handWrittenTopLevel: ReadonlySet<string>;
}

interface DeriveResult {
  readonly entries: ReadonlyArray<ApiCommandEntry>;
  readonly schemas: Readonly<Record<string, ApiCommandSchemas>>;
  readonly problems: ReadonlyArray<string>;
}

interface Operation {
  readonly id: string;
  readonly method: ApiCommandEntry["method"];
  readonly path: string;
  readonly node: JsonObject;
  readonly pathItem: JsonObject;
}

interface OperationMetadata {
  readonly group?: string;
  readonly method?: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly sensitive: ReadonlyArray<string>;
  readonly poll?: ApiCommandPoll;
  readonly wait?: ApiCommandWait;
}

interface FlagShape {
  readonly type: ApiCommandFlag["type"];
  readonly choices?: ReadonlyArray<string>;
  readonly repeatable: boolean;
}

const asRecord = (value: unknown): JsonObject | undefined =>
  Predicate.isReadonlyObject(value) ? value : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const MAX_REF_DEPTH = 32;

const lookupRef = (spec: JsonObject, ref: string): unknown => {
  if (!ref.startsWith("#/")) return undefined;
  let target: unknown = spec;
  for (const segment of ref.slice(2).split("/")) {
    target = asRecord(target)?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return target;
};

/** Follows `$ref` chains within the document; unresolvable references yield `undefined`. */
const resolve = (spec: JsonObject, value: unknown): unknown => {
  let current = value;
  for (let depth = 0; depth < MAX_REF_DEPTH; depth++) {
    const ref = asString(asRecord(current)?.$ref);
    if (ref === undefined) return current;
    current = lookupRef(spec, ref);
  }
  return undefined;
};

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set(["discriminator", "xml", "externalDocs"]);
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "format",
  "title",
  "description",
  "default",
  "enum",
  "const",
  "required",
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "readOnly",
  "writeOnly",
  "deprecated",
]);
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties"] as const;

/**
 * Copies an OpenAPI 3.0 schema as JSON Schema 2020-12: every `$ref` is inlined and 3.0-only
 * keywords are converted. A keyword with no conversion fails generation.
 */
const toJsonSchema = (
  spec: JsonObject,
  node: unknown,
  stack: ReadonlyArray<string>,
  fail: (reason: string) => void,
): unknown => {
  const schema = asRecord(node);
  if (schema === undefined) {
    fail("schema is not an object");
    return {};
  }
  const recurse = (child: unknown) => toJsonSchema(spec, child, stack, fail);
  const ref = asString(schema.$ref);
  if (ref !== undefined) {
    if (stack.includes(ref)) {
      fail(`unsupported in this runtime: recursive schema reference ${ref}`);
      return {};
    }
    const target = lookupRef(spec, ref);
    if (target === undefined) {
      fail(`schema reference ${ref} does not resolve`);
      return {};
    }
    return toJsonSchema(spec, target, [...stack, ref], fail);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key) || key === "nullable" || key === "example") continue;
    if (key === "exclusiveMinimum" || key === "exclusiveMaximum") continue;
    if (DATA_KEYWORDS.has(key) || key.startsWith("x-")) {
      out[key] = value;
    } else if (key === "items" || key === "not") {
      out[key] = recurse(value);
    } else if (key === "additionalProperties") {
      out[key] = typeof value === "boolean" ? value : recurse(value);
    } else if (SCHEMA_LIST_KEYWORDS.some((keyword) => keyword === key)) {
      out[key] = asArray(value).map(recurse);
    } else if (SCHEMA_MAP_KEYWORDS.some((keyword) => keyword === key)) {
      out[key] = Object.fromEntries(
        Object.entries(asRecord(value) ?? {}).map(([name, child]) => [name, recurse(child)]),
      );
    } else {
      fail(
        `unsupported in this runtime: schema keyword "${key}" has no JSON Schema 2020-12 conversion`,
      );
    }
  }

  for (const [exclusive, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    const flag = schema[exclusive];
    if (typeof flag === "number") {
      out[exclusive] = flag;
    } else if (flag === true) {
      if (typeof schema[bound] === "number") {
        out[exclusive] = schema[bound];
        delete out[bound];
      } else {
        fail(`schema sets ${exclusive}: true without ${bound}`);
      }
    } else if (flag !== undefined && flag !== false) {
      fail(`schema keyword "${exclusive}" has an unsupported value`);
    }
  }

  if (schema.example !== undefined) {
    if (out.examples !== undefined) fail('schema has both "example" and "examples"');
    out.examples = [schema.example];
  }

  if (schema.nullable === true) {
    const type = out.type;
    if (typeof type === "string") {
      out.type = [type, "null"];
    } else if (Array.isArray(type)) {
      out.type = [...type, "null"];
    } else {
      return { anyOf: [out, { type: "null" }] };
    }
  } else if (schema.nullable !== undefined && schema.nullable !== false) {
    fail('schema keyword "nullable" has an unsupported value');
  }
  return out;
};

const withDialect = (schema: unknown): unknown => ({
  $schema: JSON_SCHEMA_DIALECT,
  ...asRecord(schema),
});

const escapePointer = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

interface SuccessResponse {
  readonly status: number;
  readonly kind: "json" | "text" | "empty";
  readonly schema?: unknown;
}

/** Classifies the 2xx responses; the first one by status code is the one commands report. */
const classifySuccess = (
  spec: JsonObject,
  operation: Operation,
  fail: (reason: string) => void,
): SuccessResponse | undefined => {
  const responses = asRecord(operation.node.responses) ?? {};
  const classified: Array<SuccessResponse> = [];
  for (const code of Object.keys(responses).sort()) {
    if (!code.startsWith("2")) continue;
    const status = Number(code);
    if (!Number.isInteger(status)) {
      fail(`unsupported in this runtime: response status "${code}"`);
      continue;
    }
    const content = asRecord(asRecord(resolve(spec, responses[code]))?.content) ?? {};
    const types = Object.keys(content);
    const json = types.find((type) => type === "application/json" || type.endsWith("+json"));
    if (types.length === 0) {
      classified.push({ status, kind: "empty" });
    } else if (json !== undefined) {
      classified.push({ status, kind: "json", schema: asRecord(content[json])?.schema ?? {} });
    } else if (types.every((type) => type.startsWith("text/") && type !== "text/event-stream")) {
      classified.push({ status, kind: "text" });
    } else {
      fail(
        `unsupported in this runtime: ${code} response is binary or streaming (${types.join(", ")})`,
      );
    }
  }
  if (classified.length === 0 && !Object.keys(responses).some((code) => code.startsWith("2"))) {
    fail("operation has no 2xx response");
  }
  return classified[0];
};

const kebabCase = (field: string): string =>
  field
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();

/** `tables` to `table`, `entries` to `entry`; names ending in `ss`, `us` or `is` stay as they are. */
const singular = (kebab: string): string => {
  if (kebab.endsWith("ies")) return `${kebab.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/u.test(kebab) || !kebab.endsWith("s")) return kebab;
  return kebab.slice(0, -1);
};

const credentialLike = (field: string): boolean =>
  kebabCase(field)
    .split("-")
    .some((token) => CREDENTIAL_TOKENS.has(token.replace(/s$/u, "")));

const describeScalar = (
  spec: JsonObject,
  raw: unknown,
): Pick<FlagShape, "type" | "choices"> | undefined => {
  const schema = asRecord(resolve(spec, raw));
  if (schema === undefined) return undefined;
  if (["anyOf", "oneOf", "allOf", "not"].some((keyword) => keyword in schema)) return undefined;
  const type = schema.type;
  if (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean") {
    return undefined;
  }
  if (schema.enum === undefined) return { type };
  const choices = asArray(schema.enum);
  if (type !== "string" || !choices.every((choice) => typeof choice === "string")) {
    return undefined;
  }
  return { type, choices: choices.filter(Predicate.isString) };
};

const describeFlagSchema = (spec: JsonObject, raw: unknown): FlagShape | undefined => {
  const schema = asRecord(resolve(spec, raw));
  if (schema?.type === "array") {
    const items = describeScalar(spec, schema.items);
    return items === undefined ? undefined : { ...items, repeatable: true };
  }
  const scalar = describeScalar(spec, raw);
  return scalar === undefined ? undefined : { ...scalar, repeatable: false };
};

const isSecretField = (spec: JsonObject, raw: unknown): boolean => {
  const schema = asRecord(resolve(spec, raw));
  return (
    schema?.writeOnly === true || schema?.format === "password" || schema?.["x-sensitive"] === true
  );
};

const schemaDescription = (spec: JsonObject, raw: unknown): string | undefined =>
  asString(asRecord(resolve(spec, raw))?.description);

const resolvePointer = (spec: JsonObject, root: unknown, pointer: string): unknown => {
  if (!pointer.startsWith("/")) return undefined;
  let current = resolve(spec, root);
  for (const segment of pointer.slice(1).split("/")) {
    const node = asRecord(current);
    if (node === undefined) return undefined;
    const property = asRecord(node.properties)?.[segment];
    if (property !== undefined) {
      current = resolve(spec, property);
    } else if (node.type === "array" && /^\d+$/u.test(segment) && node.items !== undefined) {
      current = resolve(spec, node.items);
    } else {
      return undefined;
    }
  }
  return current;
};

const successSchema = (spec: JsonObject, operation: Operation): unknown => {
  const responses = asRecord(operation.node.responses) ?? {};
  for (const code of Object.keys(responses).sort()) {
    if (!code.startsWith("2")) continue;
    const response = asRecord(resolve(spec, responses[code]));
    const media = asRecord(asRecord(response?.content)?.["application/json"]);
    if (media?.schema !== undefined) return media.schema;
  }
  return undefined;
};

const collectOperations = (spec: JsonObject): ReadonlyMap<string, Operation> => {
  const operations = new Map<string, Operation>();
  for (const [path, rawItem] of Object.entries(asRecord(spec.paths) ?? {})) {
    const pathItem = asRecord(rawItem);
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const node = asRecord(pathItem[method]);
      const id = asString(node?.operationId);
      if (node === undefined || id === undefined) continue;
      operations.set(id, {
        id,
        method: method.toUpperCase() as ApiCommandEntry["method"],
        path,
        node,
        pathItem,
      });
    }
  }
  return operations;
};

const operationParameters = (spec: JsonObject, operation: Operation): ReadonlyArray<JsonObject> =>
  [...asArray(operation.pathItem.parameters), ...asArray(operation.node.parameters)]
    .map((raw) => asRecord(resolve(spec, raw)))
    .filter(Predicate.isNotUndefined);

/** Merges each generated operation's `x-operation` with its override entry; the override wins field by field. */
const mergeMetadata = (
  operations: ReadonlyMap<string, Operation>,
  generated: ReadonlyArray<string>,
  overrides: Readonly<Record<string, ApiCommandOverride>>,
  problems: Array<string>,
): ReadonlyMap<string, OperationMetadata> => {
  const merged = new Map<string, OperationMetadata>();
  for (const operationId of Object.keys(overrides)) {
    if (!generated.includes(operationId)) {
      problems.push(`${operationId}: override entry is for an operation that is not generated`);
    }
  }
  for (const operationId of generated) {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      problems.push(`${operationId}: generated operation has no operation in the spec`);
      continue;
    }
    const override = overrides[operationId];
    const block = operation.node["x-operation"];
    let fromSpec: XOperation | undefined;
    if (block !== undefined) {
      const decoded = decodeXOperation(block);
      if (Exit.isFailure(decoded)) {
        problems.push(`${operationId}: invalid x-operation: ${Cause.pretty(decoded.cause)}`);
        continue;
      }
      fromSpec = decoded.value;
    }
    const group = override?.group ?? fromSpec?.group;
    const method = override?.method ?? fromSpec?.method;
    if (group === undefined || method === undefined) {
      problems.push(`${operationId}: no command name; set group and method`);
    }
    const poll = override?.poll ?? fromSpec?.poll;
    merged.set(operationId, {
      ...(group === undefined ? {} : { group }),
      ...(method === undefined ? {} : { method }),
      flags: { ...override?.flags },
      sensitive: [...(override?.sensitive ?? [])],
      ...(poll === undefined ? {} : { poll }),
      ...(override?.wait === undefined ? {} : { wait: override.wait }),
    });
    if (poll !== undefined && operation.method !== "GET") {
      problems.push(`${operationId}: poll belongs on a read operation, not ${operation.method}`);
    }
  }
  return merged;
};

const RESPONSE_POINTER = /^\$response\.body#(\/.*)$/u;
const REQUEST_PATH = /^\$request\.path\.(.+)$/u;

/**
 * The wait a command's 2xx response `links` declare: the one link whose target operation has
 * `poll`. Links to operations without `poll` are ignored; a polled target that is not generated fails.
 */
const linkedWait = (
  spec: JsonObject,
  operations: ReadonlyMap<string, Operation>,
  metadata: ReadonlyMap<string, OperationMetadata>,
  operation: Operation,
  fail: (reason: string) => void,
): ApiCommandWait | undefined => {
  const responses = asRecord(operation.node.responses) ?? {};
  const waits: Array<ApiCommandWait> = [];
  for (const code of Object.keys(responses).sort()) {
    if (!code.startsWith("2")) continue;
    const links = asRecord(asRecord(resolve(spec, responses[code]))?.links) ?? {};
    for (const [linkName, rawLink] of Object.entries(links)) {
      const link = asRecord(resolve(spec, rawLink));
      const targetId = asString(link?.operationId);
      if (link === undefined || targetId === undefined) {
        fail(`link "${linkName}" must name its target with operationId`);
        continue;
      }
      const target = operations.get(targetId);
      if (target === undefined) {
        fail(`link "${linkName}" targets unknown operation "${targetId}"`);
        continue;
      }
      const poll = metadata.get(targetId)?.poll;
      if (poll === undefined) {
        if (!metadata.has(targetId) && asRecord(target.node["x-operation"])?.poll !== undefined) {
          fail(
            `link "${linkName}" targets "${targetId}", which declares poll but is not generated`,
          );
        }
        continue;
      }

      const params: Record<string, string> = {};
      for (const [parameter, expression] of Object.entries(asRecord(link.parameters) ?? {})) {
        const pointer = typeof expression === "string" ? RESPONSE_POINTER.exec(expression) : null;
        const pathName = typeof expression === "string" ? REQUEST_PATH.exec(expression)?.[1] : null;
        if (pointer?.[1] !== undefined) {
          params[parameter] = pointer[1];
        } else if (pathName !== null && pathName !== undefined) {
          const hasPath = (candidate: Operation) =>
            operationParameters(spec, candidate).some(
              (item) => item.in === "path" && item.name === pathName,
            );
          if (parameter !== pathName || !hasPath(target) || !hasPath(operation)) {
            fail(
              `link "${linkName}" parameter "${parameter}": "${String(expression)}" needs a path parameter of that name on both operations`,
            );
          }
        } else {
          fail(
            `link "${linkName}" parameter "${parameter}": unsupported expression ${JSON.stringify(expression)}`,
          );
        }
      }
      waits.push({
        read: targetId,
        params,
        status: poll.status,
        succeeded: poll.succeeded,
        failed: poll.failed,
        ...(poll.error === undefined ? {} : { error: poll.error }),
      });
    }
  }
  if (waits.length > 1) {
    fail(
      `more than one response link targets a polled operation (${waits.map((w) => w.read).join(", ")})`,
    );
    return undefined;
  }
  return waits[0];
};

/** Derives the generated commands from the merged `x-operation` and override metadata and collects every lint failure. */
export function deriveApiCommands(input: DeriveInput): DeriveResult {
  const { spec, generated, overrides, nouns, operationIdMap, handWrittenTopLevel } = input;
  const operations = collectOperations(spec);
  const problems: Array<string> = [];
  const metadata = mergeMetadata(operations, generated, overrides, problems);
  const commandNamed = new Set(
    [...metadata].flatMap(([id, item]) =>
      item.group !== undefined && item.method !== undefined ? [id] : [],
    ),
  );
  const entries: Array<ApiCommandEntry> = [];
  const schemas: Record<string, ApiCommandSchemas> = {};
  const commandOwners = new Map<string, string>();

  for (const [operationId, name] of metadata) {
    const { group, method } = name;
    if (group === undefined || method === undefined) continue;
    const fail = (reason: string) => problems.push(`${operationId}: ${reason}`);
    const operation = operations.get(operationId);
    if (operation === undefined) continue;
    const definition = operationIdMap[operationId];
    if (definition === undefined) {
      fail("operation is missing from the typed client; regenerate @supabase/api");
      continue;
    }
    const failuresBefore = problems.length;

    const command = [...group.split("."), method];
    if (!command.every((segment) => KEBAB.test(segment))) {
      fail(`command "${command.join(" ")}" must be lowercase kebab-case words`);
    }
    if (command.length > MAX_COMMAND_WORDS) {
      fail(`command "${command.join(" ")}" exceeds ${MAX_COMMAND_WORDS} words`);
    }
    if (!VERBS.has(method)) {
      fail(`verb "${method}" is outside the vocabulary; use a listed verb`);
    }
    const noun = nouns[command[0] ?? ""];
    if (noun === undefined) {
      fail(`noun "${command[0]}" is missing from the nouns table`);
    }
    const commandKey = command.join(" ");
    const owner = commandOwners.get(commandKey);
    if (owner !== undefined) fail(`command "${commandKey}" is already generated by ${owner}`);
    commandOwners.set(commandKey, operationId);
    if (handWrittenTopLevel.has(command[0] ?? "")) {
      fail(`command "${commandKey}" collides with the hand-written "${command[0]}" command`);
    }

    const stability = asString(operation.node["x-scalar-stability"]);
    if (stability !== "experimental") {
      fail(
        "stable generated commands need the R8 baseline check, not implemented yet (x-scalar-stability must be experimental)",
      );
    }
    const summary = asString(operation.node.summary);
    if (summary === undefined) fail("operation has no summary");

    const renames = name.flags;
    const sensitive = name.sensitive;
    const fields: Array<{
      readonly location: "query" | "body";
      readonly key: string;
      readonly pointer?: string;
      readonly shape: FlagShape;
      readonly required: boolean;
      readonly description: string | undefined;
      readonly writeOnly: boolean;
    }> = [];

    const pathBindings: Array<ApiCommandBinding> = [];
    for (const parameter of operationParameters(spec, operation)) {
      const parameterName = asString(parameter.name) ?? "";
      switch (parameter.in) {
        case "path":
          if (parameterName === "ref") {
            pathBindings.push({ location: "path", name: "ref", source: "target" });
          } else {
            fail(`unsupported in this runtime: path parameter "${parameterName}"`);
          }
          break;
        case "query": {
          const shape = describeFlagSchema(spec, parameter.schema);
          if (parameterName === "dry_run") {
            fail('unsupported in this runtime: server-side "dry_run" parameter');
          } else if (shape === undefined || shape.repeatable) {
            fail(`unsupported in this runtime: query parameter "${parameterName}" is not a scalar`);
          } else {
            fields.push({
              location: "query",
              key: parameterName,
              shape,
              required: parameter.required === true,
              description:
                asString(parameter.description) ?? schemaDescription(spec, parameter.schema),
              writeOnly: false,
            });
          }
          break;
        }
        default:
          fail(`unsupported in this runtime: ${String(parameter.in)} parameter "${parameterName}"`);
      }
    }

    let body: ApiCommandEntry["body"];
    let requestSchema: unknown;
    const requestBody = asRecord(resolve(spec, operation.node.requestBody));
    if (requestBody !== undefined) {
      const content = asRecord(requestBody.content) ?? {};
      const mediaTypes = Object.keys(content);
      const bodySchema = asRecord(resolve(spec, asRecord(content["application/json"])?.schema));
      const properties = asRecord(bodySchema?.properties);
      if (
        mediaTypes.length !== 1 ||
        bodySchema?.type !== "object" ||
        properties === undefined ||
        ["anyOf", "oneOf", "allOf"].some((keyword) => keyword in bodySchema)
      ) {
        fail(
          `unsupported in this runtime: request body (${mediaTypes.join(", ") || "none"}) is not a JSON object`,
        );
      } else {
        const data = asRecord(resolve(spec, properties.data));
        const dataProperties = asRecord(data?.properties);
        const typeEnum = asArray(asRecord(resolve(spec, dataProperties?.type))?.enum);
        const attributes = asRecord(resolve(spec, dataProperties?.attributes));
        const envelopeType = asString(typeEnum[0]);
        const isEnvelope =
          Object.keys(properties).length === 1 &&
          typeEnum.length === 1 &&
          envelopeType !== undefined &&
          attributes?.type === "object" &&
          asRecord(attributes.properties) !== undefined;
        const fieldProperties = isEnvelope ? asRecord(attributes?.properties) : properties;
        const required = asArray(isEnvelope ? asRecord(attributes)?.required : bodySchema.required);
        requestSchema = asRecord(content["application/json"])?.schema;
        body = isEnvelope
          ? { contentType: "application/json", kind: "json-envelope", type: envelopeType }
          : { contentType: "application/json", kind: "json-object" };
        for (const [field, schema] of Object.entries(fieldProperties ?? {})) {
          const shape = describeFlagSchema(spec, schema);
          if (field === "dry_run") {
            fail('unsupported in this runtime: server-side "dry_run" body field');
          } else if (shape === undefined) {
            fail(
              `unsupported in this runtime: body field "${field}" is not a scalar, string enum or array of scalars`,
            );
          } else {
            fields.push({
              location: "body",
              key: field,
              pointer: isEnvelope
                ? `/data/attributes/${escapePointer(field)}`
                : `/${escapePointer(field)}`,
              shape,
              required: required.includes(field),
              description: schemaDescription(spec, schema),
              writeOnly: isSecretField(spec, schema),
            });
          }
        }
      }
    }

    for (const key of Object.keys(renames)) {
      if (!fields.some((field) => field.key === key)) {
        fail(`flags rename "${key}" matches no query parameter or body field`);
      }
    }
    for (const key of sensitive) {
      if (!fields.some((field) => field.location === "body" && field.key === key)) {
        fail(`sensitive "${key}" matches no body field`);
      }
    }

    const flags: Array<ApiCommandFlag> = [];
    const bindings: Array<ApiCommandBinding> = [...pathBindings];
    const seenNames = new Set<string>();
    const seenKeys = new Set<string>();
    for (const field of fields) {
      const conventional =
        field.location === "body" && field.shape.repeatable
          ? singular(kebabCase(field.key))
          : kebabCase(field.key);
      const flagName = renames[field.key] ?? conventional;
      if (!KEBAB.test(flagName)) fail(`flag "${flagName}" must be lowercase kebab-case`);
      if (RESERVED_FLAGS.has(flagName)) {
        fail(
          `flag "--${flagName}" (from "${field.key}") collides with a reserved runtime flag; rename it`,
        );
      }
      if (seenNames.has(flagName)) {
        fail(`flag "--${flagName}" (from "${field.key}") is produced twice; rename one`);
      }
      if (seenKeys.has(field.key)) {
        fail(`"${field.key}" is both a query parameter and a body field`);
      }
      seenNames.add(flagName);
      seenKeys.add(field.key);
      const isSensitive =
        field.location === "body" && (field.writeOnly || sensitive.includes(field.key));
      if (field.location === "body" && credentialLike(field.key) && !isSensitive) {
        fail(
          `body field "${field.key}" looks like a credential; review it and list it under sensitive`,
        );
      }
      bindings.push(
        field.location === "body" && field.pointer !== undefined
          ? {
              location: "body",
              name: field.key,
              pointer: field.pointer,
              source: "flag",
              flag: flagName,
            }
          : { location: "query", name: field.key, source: "flag", flag: flagName },
      );
      flags.push({
        name: flagName,
        type: field.shape.type,
        ...(field.shape.choices === undefined ? {} : { choices: field.shape.choices }),
        repeatable: field.shape.repeatable,
        required: field.required,
        ...(isSensitive ? { sensitive: true as const } : {}),
        ...(field.description === undefined ? {} : { description: field.description }),
      });
    }

    const wait = name.wait ?? linkedWait(spec, operations, metadata, operation, fail);
    if (wait !== undefined) {
      lintWait({ spec, operations, commandNamed, operation, wait, fail });
    }

    const response = classifySuccess(spec, operation, fail);
    const schemaSet: ApiCommandSchemas | undefined =
      response === undefined
        ? undefined
        : {
            ...(requestSchema === undefined
              ? {}
              : {
                  request: {
                    contentType: "application/json" as const,
                    schema: withDialect(toJsonSchema(spec, requestSchema, [], fail)),
                  },
                }),
            result:
              response.kind === "empty"
                ? withDialect({ type: "null" })
                : response.kind === "text"
                  ? withDialect({ type: "string" })
                  : withDialect(toJsonSchema(spec, response.schema, [], fail)),
          };

    if (problems.length > failuresBefore || summary === undefined) continue;
    if (response === undefined || schemaSet === undefined) continue;
    schemas[operationId] = schemaSet;
    const description = asString(operation.node.description)?.trim();
    entries.push({
      command,
      operationId,
      definition,
      method: operation.method,
      apiPath: operation.path,
      summary,
      ...(description === undefined || description === "" ? {} : { description }),
      scope: "project",
      readOnly: operation.method === "GET",
      stability: "experimental",
      ...(noun?.feature === undefined ? {} : { feature: noun.feature }),
      ...(body === undefined ? {} : { body }),
      response: { status: response.status, kind: response.kind },
      flags,
      bindings,
      ...(wait === undefined ? {} : { wait }),
    });
  }

  entries.sort((left, right) =>
    left.command.join(" ").localeCompare(right.command.join(" "), "en"),
  );
  return { entries, schemas, problems };
}

function lintWait(input: {
  readonly spec: JsonObject;
  readonly operations: ReadonlyMap<string, Operation>;
  readonly commandNamed: ReadonlySet<string>;
  readonly operation: Operation;
  readonly wait: ApiCommandWait;
  readonly fail: (reason: string) => void;
}): void {
  const { spec, operations, commandNamed, operation, wait, fail } = input;
  const readOperation = operations.get(wait.read);
  if (readOperation === undefined) {
    fail(`wait.read "${wait.read}" has no operation in the spec`);
    return;
  }
  if (!commandNamed.has(wait.read)) {
    fail(`wait.read "${wait.read}" is not a generated command`);
  }

  const readParameters = operationParameters(spec, readOperation);
  const queryNames = new Set(
    readParameters.filter((parameter) => parameter.in === "query").map((p) => asString(p.name)),
  );
  const changeResponse = successSchema(spec, operation);
  for (const [parameter, pointer] of Object.entries(wait.params)) {
    if (!queryNames.has(parameter)) {
      fail(`wait.params "${parameter}" is not a query parameter of ${wait.read}`);
    }
    if (resolvePointer(spec, changeResponse, pointer) === undefined) {
      fail(`wait.params "${parameter}" pointer "${pointer}" does not resolve in the response`);
    }
  }
  for (const parameter of readParameters) {
    const parameterName = asString(parameter.name);
    if (
      parameter.required === true &&
      parameterName !== undefined &&
      parameterName !== "ref" &&
      wait.params[parameterName] === undefined
    ) {
      fail(`wait.params does not supply required parameter "${parameterName}" of ${wait.read}`);
    }
  }

  const readResponse = successSchema(spec, readOperation);
  const status = resolvePointer(spec, readResponse, wait.status);
  if (status === undefined) {
    fail(`wait.status pointer "${wait.status}" does not resolve in the ${wait.read} response`);
  }
  if (wait.error !== undefined && resolvePointer(spec, readResponse, wait.error) === undefined) {
    fail(`wait.error pointer "${wait.error}" does not resolve in the ${wait.read} response`);
  }
  if (wait.succeeded.length === 0) fail("wait.succeeded must list at least one status");
  const statusValues = asRecord(status)?.enum;
  if (statusValues !== undefined) {
    const allowed = asArray(statusValues);
    for (const value of [...wait.succeeded, ...wait.failed]) {
      if (!allowed.includes(value)) {
        fail(`wait status "${value}" is not in the status enum of ${wait.read}`);
      }
    }
  }
}

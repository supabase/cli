import type { OperationId } from "@supabase/api/effect";
import { Cause, Exit, Predicate, Schema } from "effect";
import {
  verbVocabulary,
  type ApiCommandPoll,
  type ApiNoun,
} from "../src/commands/api/api-command-policy.ts";
import type {
  ApiCommandBinding,
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandSchemas,
  ApiCommandWait,
  ApiPollTarget,
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
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
const MAX_COMMAND_WORDS = 4;
/** Headers the request builder owns; a spec that declares them gets no flag. */
const UNMAPPED_HEADERS: ReadonlySet<string> = new Set(["authorization", "content-type", "accept"]);
const NON_SECRET_HEADERS: ReadonlySet<string> = new Set(["idempotency-key"]);

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
  /** Hidden polling operation id to the generated operation whose command inspects its state. */
  readonly pollTargets: Readonly<Record<string, string>>;
  readonly nouns: Readonly<Record<string, ApiNoun>>;
  /** Kebab-case operation id to the camelCase key of the typed client's `operationDefinitions`. */
  readonly operationIdMap: Readonly<Record<string, OperationId>>;
  /** Top-level command names owned by hand-written commands. */
  readonly handWrittenTopLevel: ReadonlySet<string>;
}

interface DeriveResult {
  readonly entries: ReadonlyArray<ApiCommandEntry>;
  readonly pollTargets: ReadonlyArray<ApiPollTarget>;
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
  readonly group: string;
  readonly method: string;
  readonly poll?: ApiCommandPoll;
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
    const json = jsonMediaType(content);
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

const STABILITY_NOTICE = /\s*This endpoint is currently in its \*\*[^*]+\*\* stage\.\s*$/u;

/** The description without the stage paragraph the spec appends to it; `undefined` when nothing is left. */
const stripStabilityNotice = (description: string | undefined): string | undefined => {
  const stripped = description?.replace(STABILITY_NOTICE, "").trim();
  return stripped === undefined || stripped === "" ? undefined : stripped;
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

/**
 * The dotted path of the first secret a schema holds at any depth: a schema marked secret or a
 * property with a credential-like name. `visited` ends the walk on a recursive schema.
 */
const findSecret = (
  spec: JsonObject,
  raw: unknown,
  path: string,
  visited: Set<JsonObject> = new Set(),
): string | undefined => {
  const schema = asRecord(resolve(spec, raw));
  if (schema === undefined || visited.has(schema)) return undefined;
  visited.add(schema);
  if (isSecretField(spec, schema)) return path;
  const properties = Object.entries(asRecord(schema.properties) ?? {});
  const credential = properties.find(([name]) => credentialLike(name));
  if (credential !== undefined) return `${path}.${credential[0]}`;
  const children: ReadonlyArray<readonly [string, unknown]> = [
    ...properties.map(([name, child]) => [`${path}.${name}`, child] as const),
    [`${path}[]`, schema.items],
    [path, schema.additionalProperties],
    ...Object.values(asRecord(schema.patternProperties) ?? {}).map(
      (child) => [path, child] as const,
    ),
    ...SCHEMA_LIST_KEYWORDS.flatMap((keyword) =>
      asArray(schema[keyword]).map((child) => [path, child] as const),
    ),
  ];
  for (const [childPath, child] of children) {
    const found = findSecret(spec, child, childPath, visited);
    if (found !== undefined) return found;
  }
  return undefined;
};

const schemaDescription = (spec: JsonObject, raw: unknown): string | undefined =>
  asString(asRecord(resolve(spec, raw))?.description);

const pointerSegments = (pointer: string): ReadonlyArray<string> =>
  pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

const resolvePointer = (spec: JsonObject, root: unknown, pointer: string): unknown => {
  if (!pointer.startsWith("/")) return undefined;
  let current = resolve(spec, root);
  for (const segment of pointerSegments(pointer)) {
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

/** Whether `pointer` names a property that is required at every object level it passes through. */
const pointerAlwaysPresent = (spec: JsonObject, root: unknown, pointer: string): boolean => {
  if (!pointer.startsWith("/")) return false;
  let current = resolve(spec, root);
  for (const segment of pointerSegments(pointer)) {
    const node = asRecord(current);
    const property = asRecord(node?.properties)?.[segment];
    if (property === undefined || !asArray(node?.required).includes(segment)) return false;
    current = resolve(spec, property);
    if (asRecord(current)?.nullable === true) return false;
  }
  return true;
};

/** The JSON media type a response offers: `application/json` or a `+json` suffix type. */
const jsonMediaType = (content: JsonObject): string | undefined =>
  Object.keys(content).find((type) => type === "application/json" || type.endsWith("+json"));

const successSchema = (spec: JsonObject, operation: Operation): unknown => {
  const responses = asRecord(operation.node.responses) ?? {};
  for (const code of Object.keys(responses).sort()) {
    if (!code.startsWith("2")) continue;
    const response = asRecord(resolve(spec, responses[code]));
    const content = asRecord(response?.content) ?? {};
    const mediaType = jsonMediaType(content);
    const media = mediaType === undefined ? undefined : asRecord(content[mediaType]);
    if (media?.schema !== undefined) return media.schema;
  }
  return undefined;
};

export const collectOperations = (spec: JsonObject): ReadonlyMap<string, Operation> => {
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

/** Reads each generated operation's `x-operation`. */
const readMetadata = (
  operations: ReadonlyMap<string, Operation>,
  generated: ReadonlyArray<string>,
  problems: Array<string>,
): ReadonlyMap<string, OperationMetadata> => {
  const metadata = new Map<string, OperationMetadata>();
  for (const operationId of generated) {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      problems.push(`${operationId}: generated operation has no operation in the spec`);
      continue;
    }
    const block = operation.node["x-operation"];
    if (block === undefined) {
      problems.push(`${operationId}: no command name; set x-operation group and method`);
      continue;
    }
    const decoded = decodeXOperation(block);
    if (Exit.isFailure(decoded)) {
      problems.push(`${operationId}: invalid x-operation: ${Cause.pretty(decoded.cause)}`);
      continue;
    }
    const { group, method, poll } = decoded.value;
    metadata.set(operationId, { group, method, ...(poll === undefined ? {} : { poll }) });
    if (poll !== undefined && operation.method !== "GET") {
      problems.push(`${operationId}: poll belongs on a read operation, not ${operation.method}`);
    }
  }
  return metadata;
};

/** Reads each internal polling target's `poll` and checks its map entry against the generated operations. */
const readPollTargets = (
  operations: ReadonlyMap<string, Operation>,
  generated: ReadonlyArray<string>,
  targets: Readonly<Record<string, string>>,
  problems: Array<string>,
): ReadonlyMap<string, ApiCommandPoll> => {
  const polls = new Map<string, ApiCommandPoll>();
  for (const [targetId, inspectId] of Object.entries(targets)) {
    const fail = (reason: string) => problems.push(`${targetId}: ${reason}`);
    const target = operations.get(targetId);
    if (target === undefined) {
      fail("polling target has no operation in the spec");
      continue;
    }
    if (generated.includes(targetId)) {
      fail("polling target is also a generated operation; remove it from pollTargets");
    }
    if (!generated.includes(inspectId)) {
      fail(`inspect operation "${inspectId}" is not a generated operation`);
    }
    const block = target.node["x-operation"];
    if (block === undefined) {
      fail("polling target has no x-operation poll");
      continue;
    }
    const decoded = decodeXOperation(block);
    if (Exit.isFailure(decoded)) {
      fail(`invalid x-operation: ${Cause.pretty(decoded.cause)}`);
    } else if (decoded.value.poll === undefined) {
      fail("polling target declares no poll");
    } else {
      polls.set(targetId, decoded.value.poll);
    }
  }
  return polls;
};

const requireExperimental = (operation: Operation, fail: (reason: string) => void): void => {
  if (asString(operation.node["x-scalar-stability"]) !== "experimental") {
    fail("only operations marked experimental can be generated (x-scalar-stability)");
  }
};

const requireOneWait = (
  ownPoll: ApiCommandPoll | undefined,
  linked: ApiCommandWait | undefined,
  fail: (reason: string) => void,
): void => {
  if (ownPoll !== undefined && linked !== undefined) {
    fail(`declares poll and also links to the polled operation "${linked.read}"; use one`);
  }
};

const pollWait = (
  read: string,
  params: Readonly<Record<string, string>>,
  poll: ApiCommandPoll,
): ApiCommandWait => ({
  read,
  params,
  status: poll.status,
  succeeded: poll.succeeded,
  failed: poll.failed,
  ...(poll.error === undefined ? {} : { error: poll.error }),
});

const RESPONSE_POINTER = /^\$response\.body#(\/.*)$/u;
const REQUEST_PATH = /^\$request\.path\.(.+)$/u;

/**
 * The wait a command's 2xx response `links` declare: the one link whose target operation has
 * `poll`. The target is a generated operation or a listed polling target; links without `poll`
 * are ignored.
 */
const linkedWait = (
  spec: JsonObject,
  operations: ReadonlyMap<string, Operation>,
  polls: ReadonlyMap<string, ApiCommandPoll>,
  generated: ReadonlyArray<string>,
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
      const poll = polls.get(targetId);
      if (poll === undefined) {
        if (
          !generated.includes(targetId) &&
          asRecord(target.node["x-operation"])?.poll !== undefined
        ) {
          fail(
            `link "${linkName}" targets polled operation "${targetId}", which is neither generated nor listed in pollTargets`,
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
          if (pathName !== "ref") {
            fail(
              `link "${linkName}" parameter "${parameter}": only "$request.path.ref" is supported in this runtime`,
            );
          } else if (parameter !== pathName || !hasPath(target) || !hasPath(operation)) {
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
      waits.push(pollWait(targetId, params, poll));
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

/** Derives the generated commands from each operation's `x-operation` and collects every lint failure. */
export function deriveApiCommands(input: DeriveInput): DeriveResult {
  const {
    spec,
    generated,
    pollTargets: pollTargetMap,
    nouns,
    operationIdMap,
    handWrittenTopLevel,
  } = input;
  const operations = collectOperations(spec);
  const problems: Array<string> = [];
  const metadata = readMetadata(operations, generated, problems);
  const polls = new Map<string, ApiCommandPoll>();
  for (const [operationId, name] of metadata) {
    if (name.poll !== undefined) polls.set(operationId, name.poll);
  }
  const hiddenPolls = readPollTargets(operations, generated, pollTargetMap, problems);
  for (const [operationId, poll] of hiddenPolls) polls.set(operationId, poll);
  const entries: Array<ApiCommandEntry> = [];
  const schemas: Record<string, ApiCommandSchemas> = {};
  const commandOwners = new Map<string, string>();
  const groupPaths = new Set<string>();

  for (const [operationId, name] of metadata) {
    const { group, method } = name;
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
    if (command.length > MAX_COMMAND_WORDS) {
      fail(`command "${command.join(" ")}" has more than four words`);
    }
    if (!command.every((segment) => KEBAB.test(segment))) {
      fail(`command "${command.join(" ")}" must be lowercase kebab-case words`);
    }
    if (!VERBS.has(method)) {
      fail(`verb "${method}" is outside the vocabulary; use a listed verb`);
    }
    const noun = nouns[command[0] ?? ""];
    if (noun === undefined) {
      fail(`noun "${command[0]}" is missing from the nouns table`);
      continue;
    }
    const commandKey = command.join(" ");
    const owner = commandOwners.get(commandKey);
    if (owner !== undefined) fail(`command "${commandKey}" is already generated by ${owner}`);
    commandOwners.set(commandKey, operationId);
    if (groupPaths.has(commandKey)) fail(`command "${commandKey}" is both a command and a group`);
    for (let depth = 2; depth < command.length; depth += 1) {
      const groupKey = command.slice(0, depth).join(" ");
      if (commandOwners.has(groupKey)) fail(`command "${groupKey}" is both a command and a group`);
      groupPaths.add(groupKey);
      const subGroup = command.slice(1, depth).join(".");
      if (noun.groups?.[subGroup] === undefined) {
        fail(`group "${subGroup}" has no description in the nouns table`);
      }
    }
    if (handWrittenTopLevel.has(command[0] ?? "")) {
      fail(`command "${commandKey}" collides with the hand-written "${command[0]}" command`);
    }

    requireExperimental(operation, fail);
    const summary = asString(operation.node.summary);
    if (summary === undefined) fail("operation has no summary");

    const fields: Array<{
      readonly location: "query" | "header" | "body";
      readonly key: string;
      readonly pointer?: string;
      readonly shape: FlagShape;
      readonly required: boolean;
      readonly description: string | undefined;
      readonly writeOnly: boolean;
    }> = [];

    const fileOnlyFields: Array<string> = [];
    const pathBindings: Array<ApiCommandBinding> = [];
    const pathNames: Array<string> = [];
    const positionals: Array<{
      readonly name: string;
      readonly parameter: string;
      readonly description: string | undefined;
    }> = [];
    for (const parameter of operationParameters(spec, operation)) {
      const parameterName = asString(parameter.name) ?? "";
      switch (parameter.in) {
        case "path": {
          pathNames.push(parameterName);
          if (parameterName === "ref") {
            pathBindings.push({ location: "path", name: "ref", source: "target" });
            break;
          }
          const shape = describeFlagSchema(spec, parameter.schema);
          if (shape === undefined || shape.repeatable) {
            fail(`unsupported in this runtime: path parameter "${parameterName}" is not a scalar`);
          } else if (shape.type !== "string") {
            fail(`unsupported in this runtime: path parameter "${parameterName}" is not a string`);
          } else {
            positionals.push({
              name: kebabCase(parameterName),
              parameter: parameterName,
              description:
                asString(parameter.description) ?? schemaDescription(spec, parameter.schema),
            });
          }
          break;
        }
        case "header": {
          const lowerName = parameterName.toLowerCase();
          if (UNMAPPED_HEADERS.has(lowerName)) break;
          const shape = describeFlagSchema(spec, parameter.schema);
          if (
            isSecretField(spec, parameter.schema) ||
            (credentialLike(parameterName) && !NON_SECRET_HEADERS.has(lowerName))
          ) {
            fail(
              `unsupported in this runtime: header parameter "${parameterName}" carries a credential, and the dry-run preview masks only body fields`,
            );
          } else if (shape === undefined || shape.repeatable) {
            fail(
              `unsupported in this runtime: header parameter "${parameterName}" is not a scalar`,
            );
          } else {
            fields.push({
              location: "header",
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
        case "query": {
          const shape = describeFlagSchema(spec, parameter.schema);
          if (parameterName === "dry_run") {
            fail('unsupported in this runtime: server-side "dry_run" parameter');
          } else if (isSecretField(spec, parameter.schema)) {
            fail(
              `unsupported in this runtime: query parameter "${parameterName}" is a secret, and the dry-run preview masks only body fields`,
            );
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
            const secret = findSecret(spec, schema, field);
            if (secret !== undefined) {
              fail(
                `unsupported in this runtime: body field "${field}" ${secret === field ? "is a secret" : `holds the secret "${secret}"`} without a flag, and the dry-run preview masks only flag-bound fields`,
              );
            } else if (credentialLike(field)) {
              fail(
                `body field "${field}" looks like a credential; mark its schema writeOnly, format: password or x-sensitive`,
              );
            }
            fileOnlyFields.push(field);
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
              writeOnly: findSecret(spec, schema, field) !== undefined,
            });
          }
        }
      }
    }

    if (pathBindings.length === 0) {
      fail('unsupported in this runtime: operation has no "ref" path parameter');
    }
    const [positional, ...extraPositionals] = positionals;
    if (extraPositionals.length > 0) {
      fail('unsupported in this runtime: more than one path parameter besides "ref"');
    }
    if (positional !== undefined) {
      if (!KEBAB.test(positional.name)) {
        fail(`argument "${positional.name}" must be lowercase kebab-case`);
      }
      pathBindings.push({
        location: "path",
        name: positional.parameter,
        source: "argument",
        argument: positional.name,
      });
    }

    const flags: Array<ApiCommandFlag> = [];
    const bindings: Array<ApiCommandBinding> = [...pathBindings];
    const seenNames = new Set<string>();
    const seenKeys = new Set<string>(pathNames);
    for (const key of fileOnlyFields) {
      if (seenKeys.has(key)) {
        fail(
          `"${key}" is used by more than one of: path parameter, header parameter, query parameter, body field`,
        );
      }
      seenKeys.add(key);
    }
    for (const field of fields) {
      const flagName =
        field.location === "body" && field.shape.repeatable
          ? singular(kebabCase(field.key))
          : kebabCase(field.key);
      if (!KEBAB.test(flagName)) fail(`flag "${flagName}" must be lowercase kebab-case`);
      if (RESERVED_FLAGS.has(flagName)) {
        fail(`flag "--${flagName}" (from "${field.key}") collides with a reserved runtime flag`);
      }
      if (seenNames.has(flagName)) {
        fail(`flag "--${flagName}" (from "${field.key}") is produced twice`);
      }
      if (seenKeys.has(field.key)) {
        fail(
          `"${field.key}" is used by more than one of: path parameter, header parameter, query parameter, body field`,
        );
      }
      seenNames.add(flagName);
      seenKeys.add(field.key);
      const isSensitive = field.location === "body" && field.writeOnly;
      if (field.location === "body" && credentialLike(field.key) && !isSensitive) {
        fail(
          `body field "${field.key}" looks like a credential; mark its schema writeOnly, format: password or x-sensitive`,
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
          : {
              location: field.location === "header" ? "header" : "query",
              name: field.key,
              source: "flag",
              flag: flagName,
            },
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

    const linked = linkedWait(spec, operations, polls, generated, operation, fail);
    const ownPoll = name.poll;
    requireOneWait(ownPoll, linked, fail);
    const wait = linked ?? (ownPoll === undefined ? undefined : pollWait(operationId, {}, ownPoll));
    if (wait !== undefined) {
      lintWait({ spec, operations, operation, wait, fail });
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
    const description = stripStabilityNotice(asString(operation.node.description));
    entries.push({
      command,
      operationId,
      definition,
      method: operation.method,
      apiPath: operation.path,
      summary,
      ...(description === undefined ? {} : { description }),
      readOnly: operation.method === "GET",
      feature: noun.feature,
      ...(body === undefined ? {} : { body }),
      response: { status: response.status, kind: response.kind },
      ...(positional === undefined
        ? {}
        : {
            argument: {
              name: positional.name,
              ...(positional.description === undefined
                ? {}
                : { description: positional.description }),
            },
          }),
      flags,
      bindings,
      ...(wait === undefined ? {} : { wait }),
    });
  }

  entries.sort((left, right) =>
    left.command.join(" ").localeCompare(right.command.join(" "), "en"),
  );
  const pollTargets: Array<ApiPollTarget> = [];
  const reached = new Set(
    entries.flatMap((entry) => (entry.wait === undefined ? [] : [entry.wait.read])),
  );
  for (const [operationId, inspectId] of Object.entries(pollTargetMap).toSorted(([a], [b]) =>
    a.localeCompare(b, "en"),
  )) {
    const operation = operations.get(operationId);
    const poll = hiddenPolls.get(operationId);
    if (operation === undefined || poll === undefined) continue;
    const fail = (reason: string) => problems.push(`${operationId}: ${reason}`);
    if (!reached.has(operationId)) {
      fail("polling target is not linked from any generated operation; remove it from pollTargets");
      continue;
    }
    const definition = operationIdMap[operationId];
    if (definition === undefined) {
      fail("polling target is missing from the typed client; regenerate @supabase/api");
      continue;
    }
    requireExperimental(operation, fail);
    requireOneWait(poll, linkedWait(spec, operations, polls, generated, operation, fail), fail);
    const inspect = entries.find((entry) => entry.operationId === inspectId);
    if (
      inspect !== undefined &&
      (inspect.argument !== undefined ||
        inspect.body !== undefined ||
        inspect.flags.some((flag) => flag.required))
    ) {
      fail(`inspect operation "${inspectId}" needs input beyond the project ref`);
    }
    if (inspect !== undefined && !inspect.readOnly) {
      fail(`inspect operation "${inspectId}" must be a read-only command`);
    }
    const summary = asString(operation.node.summary);
    if (summary === undefined) {
      fail("polling target is missing a summary");
      continue;
    }
    const response = classifySuccess(spec, operation, fail);
    if (response === undefined) continue;
    if (response.kind !== "json") {
      fail("polling target must return JSON");
      continue;
    }
    schemas[operationId] = { result: withDialect(toJsonSchema(spec, response.schema, [], fail)) };
    pollTargets.push({
      operationId,
      definition,
      summary,
      response: { status: response.status, kind: response.kind },
      inspect: inspectId,
    });
  }
  return { entries, pollTargets, schemas, problems };
}

function lintWait(input: {
  readonly spec: JsonObject;
  readonly operations: ReadonlyMap<string, Operation>;
  readonly operation: Operation;
  readonly wait: ApiCommandWait;
  readonly fail: (reason: string) => void;
}): void {
  const { spec, operations, operation, wait, fail } = input;
  const readOperation = operations.get(wait.read);
  if (readOperation === undefined) {
    fail(`wait.read "${wait.read}" has no operation in the spec`);
    return;
  }
  if (readOperation.method !== "GET") {
    fail(`wait.read "${wait.read}" must use GET`);
  }
  if (readOperation.node.requestBody !== undefined) {
    fail(`wait.read "${wait.read}" must not require a request body`);
  }

  const readParameters = operationParameters(spec, readOperation);
  if (!readParameters.some((parameter) => parameter.in === "path" && parameter.name === "ref")) {
    fail(`wait.read "${wait.read}" must be scoped by a project ref path parameter`);
  }
  const suppliable = new Set(
    readParameters
      .filter(
        (parameter) =>
          parameter.in === "query" || (parameter.in === "path" && parameter.name !== "ref"),
      )
      .map((p) => asString(p.name)),
  );
  const changeResponse = successSchema(spec, operation);
  for (const [parameter, pointer] of Object.entries(wait.params)) {
    if (!suppliable.has(parameter)) {
      fail(`wait.params "${parameter}" is not a query or path parameter of ${wait.read}`);
    }
    if (resolvePointer(spec, changeResponse, pointer) === undefined) {
      fail(`wait.params "${parameter}" pointer "${pointer}" does not resolve in the response`);
    } else if (!pointerAlwaysPresent(spec, changeResponse, pointer)) {
      fail(
        `wait.params "${parameter}" pointer "${pointer}" is not required at every level of the response, so --wait could have nothing to poll with`,
      );
    }
  }
  for (const parameter of readParameters) {
    const parameterName = asString(parameter.name);
    if (
      wait.read !== operation.id &&
      parameter.required === true &&
      parameterName !== undefined &&
      !(parameterName === "ref" && parameter.in === "path") &&
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

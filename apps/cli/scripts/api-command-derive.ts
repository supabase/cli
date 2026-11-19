import type { OperationId } from "@supabase/api/effect";
import { isDeepStrictEqual } from "node:util";
import { Cause, Exit, Predicate, Schema } from "effect";
import { ROOT_GLOBAL_FLAGS } from "../src/command-internal/global-flags.ts";
import type { ApiNoun, ApiCommandPolicy } from "../src/commands/api/api-command-policy.ts";
import type {
  ApiCommandBinding,
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandWait,
  ApiPollTarget,
} from "../src/commands/api/api-command.model.ts";

type JsonObject = Readonly<Record<string, unknown>>;

/** Flags a generated command may not redeclare: the registered globals plus those the runtime adds itself. */
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  ...ROOT_GLOBAL_FLAGS.map((flag) => flag.id),
  "body",
  "file",
  "remote",
  "project-ref",
  "dry-run",
  "wait",
  "timeout",
  "help",
]);

const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  "password",
  "secret",
  "token",
  "key",
  "private",
]);

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
/** Headers the request builder owns; a spec may declare them, and they get no flag. */
const CLIENT_HEADERS: ReadonlySet<string> = new Set(["authorization", "content-type", "accept"]);

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

/** How to tell that the resource a read operation returns has settled. */
type ApiCommandPoll = Pick<ApiCommandWait, "status" | "succeeded" | "failed" | "error">;

const XOperationSchema = Schema.Struct({
  group: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  poll: Schema.optionalKey(
    Schema.Struct({ ...StatusMapping, inspect: Schema.optionalKey(Schema.String) }),
  ),
});

const decodeXOperation = Schema.decodeUnknownExit(XOperationSchema, {
  onExcessProperty: "error",
});

/**
 * An `x-operation` block: an optional command name and an optional poll mapping. A name generates
 * a command only for operations in the generated list.
 */
type ParsedXOperation =
  | {
      readonly kind: "valid";
      readonly name?: { readonly group: string; readonly method: string };
      readonly poll?: ApiCommandPoll;
      readonly inspect?: string;
    }
  | { readonly kind: "invalid"; readonly reason: string };

const statusMapping = (poll: ApiCommandPoll): ApiCommandPoll => ({
  status: poll.status,
  succeeded: poll.succeeded,
  failed: poll.failed,
  ...(poll.error === undefined ? {} : { error: poll.error }),
});

const parseXOperation = (block: unknown): ParsedXOperation => {
  const decoded = decodeXOperation(block);
  if (Exit.isFailure(decoded)) return { kind: "invalid", reason: Cause.pretty(decoded.cause) };
  const { group, method, poll } = decoded.value;
  if ((group === undefined) !== (method === undefined)) {
    return { kind: "invalid", reason: "a command name needs both group and method" };
  }
  if (group === undefined && poll === undefined) {
    return { kind: "invalid", reason: "set group and method, poll, or both" };
  }
  if (poll?.inspect === "") {
    return { kind: "invalid", reason: "poll.inspect must name an operation" };
  }
  return {
    kind: "valid",
    ...(group === undefined || method === undefined ? {} : { name: { group, method } }),
    ...(poll === undefined ? {} : { poll: statusMapping(poll) }),
    ...(poll?.inspect === undefined ? {} : { inspect: poll.inspect }),
  };
};

interface DeriveInput {
  readonly policies?: Readonly<Record<string, ApiCommandPolicy>>;
  /** The parsed OpenAPI document. */
  readonly spec: JsonObject;
  /** Operation ids that generate commands; the roots whose response `links` are followed. */
  readonly generated: ReadonlyArray<string>;
  readonly nouns: Readonly<Record<string, ApiNoun>>;
  /** Kebab-case operation id to the camelCase key of the typed client's `operationDefinitions`. */
  readonly operationIdMap: Readonly<Record<string, OperationId>>;
  /** Names of the hand-written root commands; a generated noun may not reuse one. */
  readonly handWrittenRoots: ReadonlySet<string>;
}

interface DeriveResult {
  readonly entries: ReadonlyArray<ApiCommandEntry>;
  readonly pollTargets: ReadonlyArray<ApiPollTarget>;
  /** Success status code of each generated command's operation, for the reference. */
  readonly successStatuses: ReadonlyMap<string, number>;
  readonly problems: ReadonlyArray<string>;
}

interface Operation {
  readonly id: string;
  readonly method: (typeof HTTP_METHODS)[number];
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

const COMPOSITION_KEYWORDS = ["anyOf", "oneOf", "allOf"];

/**
 * The fields of an envelope's attributes: a plain object, or an `anyOf` of closed objects that
 * share identical properties and differ only in what they require. A field is required only when
 * every branch requires it.
 */
const deriveAttributeFields = (
  spec: JsonObject,
  attributes: JsonObject | undefined,
): { readonly properties: JsonObject; readonly required: ReadonlyArray<unknown> } | undefined => {
  if (attributes === undefined) return undefined;
  const properties = asRecord(attributes.properties);
  const composed = COMPOSITION_KEYWORDS.filter((keyword) => keyword in attributes);
  if (composed.length === 0) {
    return attributes.type === "object" && properties !== undefined
      ? { properties, required: asArray(attributes.required) }
      : undefined;
  }
  if (composed.length !== 1 || composed[0] !== "anyOf" || properties !== undefined) {
    return undefined;
  }
  const branches = asArray(attributes.anyOf).map((branch) => asRecord(resolve(spec, branch)));
  const resolvedProperties = (branch: JsonObject | undefined) =>
    Object.entries(asRecord(branch?.properties) ?? {}).map(
      ([field, schema]) => [field, resolve(spec, schema)] as const,
    );
  const [first] = branches;
  const firstProperties = asRecord(first?.properties);
  if (
    first === undefined ||
    firstProperties === undefined ||
    branches.length < 2 ||
    !branches.every(
      (branch) =>
        branch?.type === "object" &&
        branch.additionalProperties === false &&
        isDeepStrictEqual(resolvedProperties(branch), resolvedProperties(first)),
    )
  ) {
    return undefined;
  }
  return {
    properties: firstProperties,
    required: asArray(first.required).filter((field) =>
      branches.every((branch) => asArray(branch?.required).includes(field)),
    ),
  };
};

const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

const escapePointer = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** The first 2xx status code; every command and poll target needs its success response to be JSON. */
const successStatus = (
  spec: JsonObject,
  operation: Operation,
  fail: (reason: string) => void,
): number | undefined => {
  const responses = asRecord(operation.node.responses) ?? {};
  const statuses: Array<number> = [];
  for (const code of Object.keys(responses).sort()) {
    if (!code.startsWith("2")) continue;
    const status = Number(code);
    if (!Number.isInteger(status)) {
      fail(`unsupported in this runtime: response status "${code}"`);
      continue;
    }
    const content = asRecord(asRecord(resolve(spec, responses[code]))?.content) ?? {};
    if (jsonMediaType(content) === undefined) {
      fail(
        `unsupported in this runtime: ${code} response is not JSON (${Object.keys(content).join(", ") || "no content"})`,
      );
      continue;
    }
    statuses.push(status);
  }
  if (statuses.length === 0 && !Object.keys(responses).some((code) => code.startsWith("2"))) {
    fail("operation has no 2xx response");
  }
  return statuses[0];
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
  if (type !== "string" && type !== "boolean") return undefined;
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

/** Whether a schema is a number or integer, or an array of them. */
const isNumeric = (spec: JsonObject, raw: unknown): boolean => {
  const schema = asRecord(resolve(spec, raw));
  const item = schema?.type === "array" ? asRecord(resolve(spec, schema.items)) : schema;
  return item?.type === "integer" || item?.type === "number";
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

const collectOperations = (spec: JsonObject): ReadonlyMap<string, Operation> => {
  const operations = new Map<string, Operation>();
  for (const rawItem of Object.values(asRecord(spec.paths) ?? {})) {
    const pathItem = asRecord(rawItem);
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const node = asRecord(pathItem[method.toLowerCase()]);
      const id = asString(node?.operationId);
      if (node === undefined || id === undefined) continue;
      operations.set(id, {
        id,
        method,
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
    const parsed = parseXOperation(block);
    if (parsed.kind === "invalid") {
      problems.push(`${operationId}: invalid x-operation: ${parsed.reason}`);
      continue;
    }
    const { name, poll } = parsed;
    if (name === undefined) {
      problems.push(`${operationId}: no command name; set x-operation group and method`);
      continue;
    }
    metadata.set(operationId, { ...name, ...(poll === undefined ? {} : { poll }) });
    if (poll !== undefined && operation.method !== "GET") {
      problems.push(`${operationId}: poll belongs on a read operation, not ${operation.method}`);
    }
  }
  return metadata;
};

const requireExperimental = (operation: Operation, fail: (reason: string) => void): void => {
  if (asString(operation.node["x-scalar-stability"]) !== "experimental") {
    fail("only operations marked experimental can be generated (x-scalar-stability)");
  }
};

const requireOneWait = (
  ownPoll: ApiCommandPoll | undefined,
  linkedRead: string | undefined,
  fail: (reason: string) => void,
): void => {
  if (ownPoll !== undefined && linkedRead !== undefined) {
    fail(`declares poll and also links to the polled operation "${linkedRead}"; use one`);
  }
};

/** The first operation declaring `poll` that an operation's 2xx response `links` target. */
const polledLinkTarget = (
  spec: JsonObject,
  operations: ReadonlyMap<string, Operation>,
  operation: Operation,
): string | undefined => {
  const responses = asRecord(operation.node.responses) ?? {};
  for (const code of Object.keys(responses).sort()) {
    if (!code.startsWith("2")) continue;
    const links = asRecord(asRecord(resolve(spec, responses[code]))?.links) ?? {};
    for (const rawLink of Object.values(links)) {
      const targetId = asString(asRecord(resolve(spec, rawLink))?.operationId);
      const target = targetId === undefined ? undefined : operations.get(targetId);
      if (asRecord(target?.node["x-operation"])?.poll !== undefined) return targetId;
    }
  }
  return undefined;
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

/** A polled read that is not a generated command, reached through a response link, with the operation that inspects its state. */
interface HiddenRead {
  readonly poll: ApiCommandPoll;
  readonly inspect: string;
}

/**
 * The wait a command's 2xx response `links` declare: the one link whose target operation has
 * `poll`. A target that is not a generated operation needs `poll.inspect` and is recorded in
 * `hidden`; links without `poll` are ignored.
 */
const linkedWait = (
  spec: JsonObject,
  operations: ReadonlyMap<string, Operation>,
  metadata: ReadonlyMap<string, OperationMetadata>,
  generated: ReadonlyArray<string>,
  hidden: Map<string, HiddenRead>,
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
      let poll: ApiCommandPoll | undefined;
      if (generated.includes(targetId)) {
        poll = metadata.get(targetId)?.poll;
      } else {
        const block = target.node["x-operation"];
        if (block === undefined) continue;
        const parsed = parseXOperation(block);
        if (parsed.kind === "invalid") {
          fail(
            `link "${linkName}" targets "${targetId}", whose x-operation is invalid: ${parsed.reason}`,
          );
        } else if (parsed.poll !== undefined && parsed.inspect === undefined) {
          fail(
            `link "${linkName}" targets polled operation "${targetId}", which is not a generated command and sets no poll.inspect`,
          );
        } else if (parsed.poll !== undefined && parsed.inspect !== undefined) {
          poll = parsed.poll;
          hidden.set(targetId, { poll, inspect: parsed.inspect });
        }
      }
      if (poll === undefined) continue;

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
  const { spec, generated, nouns, operationIdMap, handWrittenRoots } = input;
  const operations = collectOperations(spec);
  const problems: Array<string> = [];
  for (const id of Object.keys(input.policies ?? {})) {
    if (!input.generated.includes(id))
      problems.push(`${id}: CLI policy requires an allowlisted command`);
  }
  const metadata = readMetadata(operations, generated, problems);
  const hidden = new Map<string, HiddenRead>();
  const entries: Array<ApiCommandEntry> = [];
  const successStatuses = new Map<string, number>();
  const commandOwners = new Map<string, string>();
  const groupPaths = new Set<string>();

  for (const noun of Object.keys(nouns)) {
    if (handWrittenRoots.has(noun)) {
      problems.push(`noun "${noun}" is already a hand-written command`);
    }
  }

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
    if (!command.every((segment) => KEBAB.test(segment))) {
      fail(`command "${command.join(" ")}" must be lowercase kebab-case words`);
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
    for (let depth = 1; depth < command.length; depth += 1) {
      const groupKey = command.slice(0, depth).join(" ");
      if (depth < 2) continue;
      if (commandOwners.has(groupKey)) fail(`command "${groupKey}" is both a command and a group`);
      groupPaths.add(groupKey);
      const subGroup = command.slice(1, depth).join(".");
      if (noun.groups?.[subGroup] === undefined) {
        fail(`group "${subGroup}" has no description in the nouns table`);
      }
    }

    requireExperimental(operation, fail);
    const summary = asString(operation.node.summary);
    if (summary === undefined) fail("operation has no summary");

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
          if (!CLIENT_HEADERS.has(parameterName.toLowerCase())) {
            fail(`unsupported in this runtime: header parameter "${parameterName}"`);
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
        const hasEnvelopeShape =
          Object.keys(properties).length === 1 &&
          typeEnum.length === 1 &&
          envelopeType !== undefined;
        const attributeFields = hasEnvelopeShape
          ? deriveAttributeFields(spec, attributes)
          : undefined;
        if (
          hasEnvelopeShape &&
          attributeFields === undefined &&
          COMPOSITION_KEYWORDS.some((keyword) => attributes !== undefined && keyword in attributes)
        ) {
          fail(
            "unsupported in this runtime: envelope attributes use a schema composition other than an anyOf of closed objects over identical properties",
          );
        }
        const required = attributeFields?.required ?? [];
        if (attributeFields === undefined) {
          fail("unsupported in this runtime: request body is not a data envelope");
        } else if (envelopeType !== undefined) {
          body = { contentType: "application/json", type: envelopeType };
        }
        for (const [field, schema] of Object.entries(attributeFields?.properties ?? {})) {
          const scalarShape = describeFlagSchema(spec, schema);
          const secret = findSecret(spec, schema, field);
          if (field === "dry_run") {
            fail('unsupported in this runtime: server-side "dry_run" body field');
          } else if (scalarShape === undefined && isNumeric(spec, schema)) {
            fail(`unsupported in this runtime: numeric body field "${field}"`);
          } else if (scalarShape === undefined && secret !== undefined) {
            fail(
              `unsupported in this runtime: body field "${field}" ${secret === field ? "is a secret" : `holds the secret "${secret}"`}, and the dry-run preview masks only scalar flag values`,
            );
          }
          fields.push({
            location: "body",
            key: field,
            pointer: `/data/attributes/${escapePointer(field)}`,
            shape: scalarShape ?? { type: "json", repeatable: false },
            required: required.includes(field),
            description: schemaDescription(spec, schema),
            writeOnly: secret !== undefined,
          });
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
              location: "query",
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

    const linked = linkedWait(spec, operations, metadata, generated, hidden, operation, fail);
    const ownPoll = name.poll;
    requireOneWait(ownPoll, linked?.read, fail);
    const wait = linked ?? (ownPoll === undefined ? undefined : pollWait(operationId, {}, ownPoll));
    if (wait !== undefined) {
      lintWait({ spec, operations, operation, wait, fail });
    }

    const status = successStatus(spec, operation, fail);
    if (problems.length > failuresBefore || summary === undefined) continue;
    if (status === undefined) continue;
    const description = stripStabilityNotice(asString(operation.node.description));
    const policy = input.policies?.[operationId];
    if (policy?.confirmDescription && (operation.method === "GET" || !description)) {
      fail("confirmation details require a mutation with an API description");
      continue;
    }
    successStatuses.set(operationId, status);
    entries.push({
      command,
      operationId,
      definition,
      summary,
      ...(description === undefined ? {} : { description }),
      readOnly: operation.method === "GET",
      ...policy,
      feature: noun.feature,
      ...(body === undefined ? {} : { body }),
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
  for (const [operationId, { poll, inspect: inspectId }] of [...hidden].toSorted(([a], [b]) =>
    a.localeCompare(b, "en"),
  )) {
    const operation = operations.get(operationId);
    if (operation === undefined) continue;
    const fail = (reason: string) => problems.push(`${operationId}: ${reason}`);
    const definition = operationIdMap[operationId];
    if (definition === undefined) {
      fail("polling target is missing from the typed client; regenerate @supabase/api");
      continue;
    }
    requireExperimental(operation, fail);
    requireOneWait(poll, polledLinkTarget(spec, operations, operation), fail);
    if (!generated.includes(inspectId)) {
      fail(`inspect operation "${inspectId}" is not a generated operation`);
    }
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
    if (successStatus(spec, operation, fail) === undefined) continue;
    pollTargets.push({ operationId, definition, summary, inspect: inspectId });
  }
  return { entries, pollTargets, successStatuses, problems };
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

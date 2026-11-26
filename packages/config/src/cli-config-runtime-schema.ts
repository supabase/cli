import { Context, Effect, Option, type SchemaAST } from "effect";
import { CliConfigSchema, RemotesSchema } from "./base.ts";
import { toPublishedJsonSchemaDocument } from "./json-schema-document.ts";

type Node = Record<string, unknown>;

const VALIDATION_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "default",
  "required",
  "additionalProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "not",
  "$ref",
]);
const SCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "definitions"]);
const SCHEMA_KEYWORDS = new Set(["items", "not", "additionalProperties"]);
const CHECK_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runWithoutServices<A, E, R>(effect: Effect.Effect<A, E, R>): A {
  return Effect.runSyncWith(Context.empty() as Context.Context<R>)(effect);
}

function decodingDefaultOf(ast: SchemaAST.AST): Option.Option<unknown> {
  for (const link of ast.encoding ?? []) {
    const getter = link.transformation.decode;
    if (typeof getter === "function") {
      continue;
    }
    if (getter._tag === "TransformOptional") {
      const result = getter.transform(Option.none());
      if (Option.isSome(result)) {
        return result;
      }
    } else if (getter._tag === "TransformOptionalEffect") {
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- schema getters declare an unconstrained requirements channel
      const result = runWithoutServices(getter.transform(Option.none(), {}));
      if (Option.isSome(result)) {
        return result;
      }
    }
  }
  return Option.none();
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function reconcileDefaults(json: Node, ast: SchemaAST.AST): void {
  const branches = json["anyOf"];
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      if (isNode(branch)) {
        reconcileDefaults(branch, ast);
      }
    }
  }
  if (ast._tag === "Objects") {
    const properties = isNode(json["properties"]) ? json["properties"] : {};
    for (const property of ast.propertySignatures) {
      const child = properties[String(property.name)];
      if (!isNode(child)) {
        continue;
      }
      const fallback = decodingDefaultOf(property.type);
      if (Option.isSome(fallback)) {
        child["default"] = jsonClone(fallback.value);
      } else {
        delete child["default"];
      }
      reconcileDefaults(child, property.type);
    }
    const patterns = json["patternProperties"];
    const indexSignature = ast.indexSignatures[0];
    if (indexSignature !== undefined) {
      const valueSchemas = [
        ...(isNode(patterns) ? Object.values(patterns) : []),
        json["additionalProperties"],
      ];
      for (const child of valueSchemas) {
        if (isNode(child)) {
          reconcileDefaults(child, indexSignature.type);
        }
      }
    }
    return;
  }
  if (ast._tag === "Arrays" && isNode(json["items"]) && ast.rest[0] !== undefined) {
    reconcileDefaults(json["items"], ast.rest[0]);
  }
}

/** `UndefinedOr` renders as `anyOf: [X, { type: "null" }]`; documents never carry `undefined`, and Ajv ignores defaults inside `anyOf`. */
function withoutUndefinedBranch(node: Node): Node {
  const branches = node["anyOf"];
  if (!Array.isArray(branches)) {
    return node;
  }
  const kept = branches.filter((branch) => !(isNode(branch) && branch["type"] === "null"));
  const [only] = kept;
  if (kept.length !== 1 || !isNode(only)) {
    return node;
  }
  const { anyOf: _removed, ...rest } = node;
  return withoutUndefinedBranch({ ...only, ...rest });
}

function prune(node: unknown, structuralOnly: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => prune(item, structuralOnly));
  }
  if (!isNode(node)) {
    return node;
  }
  const source = withoutUndefinedBranch(node);
  const out: Node = {};
  for (const [key, value] of Object.entries(source)) {
    if (!VALIDATION_KEYWORDS.has(key) && !SCHEMA_LIST_KEYWORDS.has(key)) {
      if (!SCHEMA_MAP_KEYWORDS.has(key) && !SCHEMA_KEYWORDS.has(key)) {
        continue;
      }
    }
    if (structuralOnly && CHECK_KEYWORDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isNode(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, prune(child, structuralOnly)]),
      );
    } else if (SCHEMA_LIST_KEYWORDS.has(key) || SCHEMA_KEYWORDS.has(key)) {
      out[key] = prune(value, structuralOnly);
    } else if (key === "type" && structuralOnly && value === "integer") {
      out[key] = "number";
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Record keys that fail a key pattern are dropped on decode, so a pattern-only record gets `additionalProperties: false`. */
function closePatternRecords(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(closePatternRecords);
    return;
  }
  if (!isNode(node)) {
    return;
  }
  if (isNode(node["patternProperties"]) && node["additionalProperties"] === undefined) {
    node["additionalProperties"] = false;
  }
  Object.values(node).forEach(closePatternRecords);
}

function runtimeSchema(
  codec: { readonly ast: SchemaAST.AST },
  options: { readonly structuralOnly: boolean },
): Node {
  const published = toPublishedJsonSchemaDocument(codec as typeof CliConfigSchema, {
    onExcessProperty: "error",
    acceptEnvReferences: false,
  });
  const document = jsonClone(published) as Node;
  reconcileDefaults(document, codec.ast);
  const pruned = prune(document, options.structuralOnly);
  closePatternRecords(pruned);
  return isNode(pruned) ? pruned : {};
}

/** Validation-only JSON Schemas, with decoding defaults inlined, that mirror `CliConfigSchema` for a plain validator; `remotes` is validated by its own schema. */
export function toCliConfigRuntimeSchemas(): { readonly root: Node; readonly remotes: Node } {
  const root = runtimeSchema(CliConfigSchema, { structuralOnly: false });
  if (isNode(root["properties"])) {
    delete root["properties"]["remotes"];
  }
  return { root, remotes: runtimeSchema(RemotesSchema, { structuralOnly: true }) };
}

export const CLI_CONFIG_AJV_OPTIONS = {
  strict: false,
  allErrors: true,
  useDefaults: true,
  removeAdditional: true,
} as const;

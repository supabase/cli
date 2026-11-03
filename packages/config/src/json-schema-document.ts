import { JsonSchema, Schema } from "effect";
import { ENV_PATTERN } from "./lib/env.ts";

type Node = Record<string, unknown>;

const COERCED_TYPES = new Set(["number", "integer", "boolean"]);
const HOISTED_ANNOTATIONS = new Set(["title", "description", "default", "examples"]);
const DATA_KEYWORDS = new Set(["default", "examples", "enum", "const"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties"]);

/**
 * Renders a published draft-07 JSON Schema document, carrying the `x-secret` marker through and
 * keeping pattern-keyed records open: the generator writes a boolean `additionalProperties` on them
 * (effect 4.0) with no per-schema setting, while the published documents never carried one there.
 * With `acceptEnvReferences`, number, integer, boolean, string-enum and string-list leaves also
 * accept the `env(VAR)` references the loader resolves. A bare object whose only constraint is
 * one object schema in `allOf` is replaced by that schema, so editors read its properties directly.
 */
export function toPublishedJsonSchemaDocument(
  schema: Schema.Constraint,
  options: {
    readonly onExcessProperty: "ignore" | "error";
    readonly acceptEnvReferences?: boolean;
  },
) {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: options.onExcessProperty,
    includeAnnotationKey: (key) => key === "x-secret",
  });
  const root = openPatternKeyedRecords(document.schema);
  const definitions = openPatternKeyedRecords(document.definitions);
  const published = JsonSchema.toDocumentDraft07({
    dialect: "draft-2020-12",
    schema: options.acceptEnvReferences ? acceptEnvReferences(root) : root,
    definitions: options.acceptEnvReferences ? mapSchemas(definitions) : definitions,
  });
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...published.schema,
    ...(Object.keys(published.definitions).length > 0
      ? { definitions: published.definitions }
      : {}),
  };
}

function openPatternKeyedRecords<T>(node: T): T {
  if (Array.isArray(node)) return node.map(openPatternKeyedRecords) as T;
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = openPatternKeyedRecords(value);
  if (isRecordLike(out) && typeof out["additionalProperties"] === "boolean") {
    delete out["additionalProperties"];
  }
  return (singleObjectAllOf(out) ?? out) as T;
}

function singleObjectAllOf(node: Record<string, unknown>): Record<string, unknown> | undefined {
  const allOf = node["allOf"];
  if (Object.keys(node).length !== 2 || node["type"] !== "object") return undefined;
  if (!Array.isArray(allOf) || allOf.length !== 1) return undefined;
  const [member]: ReadonlyArray<unknown> = allOf;
  return isObjectSchema(member) ? member : undefined;
}

function isObjectSchema(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "object"
  );
}

function isRecordLike(node: Record<string, unknown>): boolean {
  const patternProperties = node["patternProperties"];
  return typeof patternProperties === "object" && patternProperties !== null;
}

function acceptEnvReferences<T>(node: T): T {
  if (Array.isArray(node)) return node.map(acceptEnvReferences) as T;
  if (!isNode(node)) return node;
  if (isEnvReferenceTarget(node)) return withEnvReferenceBranch(node) as T;
  const out: Node = {};
  for (const [key, value] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(key)) out[key] = value;
    else if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = mapSchemas(value);
    else if (key === "anyOf" && Array.isArray(value)) out[key] = acceptEnvReferencesInUnion(value);
    else out[key] = acceptEnvReferences(value);
  }
  return out as T;
}

function mapSchemas<T>(schemas: T): T {
  if (!isNode(schemas)) return schemas;
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, acceptEnvReferences(schema)]),
  ) as T;
}

function acceptEnvReferencesInUnion(members: ReadonlyArray<unknown>): Array<unknown> {
  const accepted = members.map((member) =>
    isEnvReferenceTarget(member) ? member : acceptEnvReferences(member),
  );
  const needsBranch = members.some(isEnvReferenceTarget) && !accepted.some(isEnvReferenceBranch);
  return needsBranch ? [...accepted, envReferenceBranch()] : accepted;
}

function withEnvReferenceBranch(node: Node): Node {
  const outer: Node = {};
  const typed: Node = {};
  for (const [key, value] of Object.entries(node)) {
    (HOISTED_ANNOTATIONS.has(key) ? outer : typed)[key] = value;
  }
  return { ...outer, anyOf: [typed, envReferenceBranch()] };
}

function envReferenceBranch(): Node {
  return { type: "string", pattern: ENV_PATTERN };
}

function isEnvReferenceBranch(node: unknown): boolean {
  if (!isNode(node) || node["type"] !== "string") return false;
  const checks = Array.isArray(node["allOf"]) ? [node, ...node["allOf"]] : [node];
  return checks.some((check) => isNode(check) && check["pattern"] === ENV_PATTERN);
}

function isEnvReferenceTarget(node: unknown): node is Node {
  if (!isNode(node) || typeof node["type"] !== "string") return false;
  if (COERCED_TYPES.has(node["type"])) return true;
  if (node["type"] === "string") return !isFreeFormString(node) && !isEmptyLiteral(node);
  return node["type"] === "array" && isFreeFormString(node["items"]);
}

function isEmptyLiteral(node: Node): boolean {
  const values = node["enum"];
  return Array.isArray(values) && values.length === 1 && values[0] === "";
}

function isFreeFormString(node: unknown): boolean {
  return isNode(node) && node["type"] === "string" && !("enum" in node);
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

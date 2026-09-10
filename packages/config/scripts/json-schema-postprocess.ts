import { SchemaAST } from "effect";

/**
 * Pure JSON Schema post-processing used by `build.ts`'s `renderJsonSchema` on
 * both generated artifacts (`dist/schema.json`, `dist/project-schema.json`).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NON_FINITE_ENUM_VALUES: ReadonlySet<string> = new Set(["Infinity", "-Infinity", "NaN"]);

function isNonFiniteStringEnumNode(node: unknown): boolean {
  if (!isRecord(node) || node["type"] !== "string") {
    return false;
  }
  const values = node["enum"];
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === "string" && NON_FINITE_ENUM_VALUES.has(value))
  );
}

function isPlainNumberNode(node: unknown): node is Record<string, unknown> {
  return isRecord(node) && node["type"] === "number";
}

interface RecoveredAnnotations {
  readonly description?: string;
  readonly default?: unknown;
}

/**
 * `description`/`default` for every `Schema.Number` leaf reachable from `ast`,
 * keyed by dotted property path (`"*"` for a record/array element) — the only
 * two annotations `Schema.toJsonSchemaDocument` drops when it splits a plain
 * `Schema.Number` into the `anyOf` union {@link collapseNonFiniteNumberUnions}
 * collapses back down.
 */
function collectNumberLeafAnnotations(
  ast: SchemaAST.AST,
  prefix: ReadonlyArray<string> = [],
  into: Map<string, RecoveredAnnotations> = new Map(),
): Map<string, RecoveredAnnotations> {
  if (SchemaAST.isObjects(ast)) {
    for (const property of ast.propertySignatures) {
      collectNumberLeafAnnotations(property.type, [...prefix, String(property.name)], into);
    }
    for (const indexSignature of ast.indexSignatures) {
      collectNumberLeafAnnotations(indexSignature.type, [...prefix, "*"], into);
    }
  } else if (SchemaAST.isArrays(ast)) {
    for (const element of ast.elements) {
      collectNumberLeafAnnotations(element, [...prefix, "*"], into);
    }
    for (const rest of ast.rest) {
      collectNumberLeafAnnotations(rest, [...prefix, "*"], into);
    }
  } else if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) {
      collectNumberLeafAnnotations(member, prefix, into);
    }
  } else if (SchemaAST.isNumber(ast)) {
    const description = ast.annotations?.["description"];
    const defaultValue = ast.annotations?.["default"];
    if (typeof description === "string" || defaultValue !== undefined) {
      into.set(prefix.join("."), {
        ...(typeof description === "string" ? { description } : {}),
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      });
    }
  }
  return into;
}

function tryCollapseNonFiniteNumberUnion(
  node: Record<string, unknown>,
  path: ReadonlyArray<string>,
  annotationsByPath: ReadonlyMap<string, RecoveredAnnotations>,
): Record<string, unknown> | undefined {
  const anyOf = node["anyOf"];
  if (!Array.isArray(anyOf) || anyOf.length !== 2) {
    return undefined;
  }
  const [first, second] = anyOf;
  const numberNode = isPlainNumberNode(first)
    ? first
    : isPlainNumberNode(second)
      ? second
      : undefined;
  const enumNode = isNonFiniteStringEnumNode(first)
    ? first
    : isNonFiniteStringEnumNode(second)
      ? second
      : undefined;
  if (numberNode === undefined || enumNode === undefined) {
    return undefined;
  }

  const { anyOf: _anyOf, ...siblings } = node;
  const merged: Record<string, unknown> = { ...numberNode, ...siblings };
  const recovered = annotationsByPath.get(path.join("."));
  if (merged["description"] === undefined && recovered?.description !== undefined) {
    merged["description"] = recovered.description;
  }
  if (merged["default"] === undefined && recovered?.default !== undefined) {
    merged["default"] = recovered.default;
  }
  return merged;
}

function collapseSchemaNode(
  node: unknown,
  path: ReadonlyArray<string>,
  annotationsByPath: ReadonlyMap<string, RecoveredAnnotations>,
): unknown {
  if (!isRecord(node)) {
    return node;
  }

  const collapsed = tryCollapseNonFiniteNumberUnion(node, path, annotationsByPath);
  if (collapsed !== undefined) {
    return collapsed;
  }

  const result: Record<string, unknown> = { ...node };

  const properties = node["properties"];
  if (isRecord(properties)) {
    result["properties"] = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        collapseSchemaNode(child, [...path, name], annotationsByPath),
      ]),
    );
  }

  const patternProperties = node["patternProperties"];
  if (isRecord(patternProperties)) {
    result["patternProperties"] = Object.fromEntries(
      Object.entries(patternProperties).map(([pattern, child]) => [
        pattern,
        collapseSchemaNode(child, [...path, "*"], annotationsByPath),
      ]),
    );
  }

  const additionalProperties = node["additionalProperties"];
  if (isRecord(additionalProperties)) {
    result["additionalProperties"] = collapseSchemaNode(
      additionalProperties,
      [...path, "*"],
      annotationsByPath,
    );
  }

  const items = node["items"];
  if (items !== undefined) {
    result["items"] = collapseSchemaNode(items, [...path, "*"], annotationsByPath);
  }

  const prefixItems = node["prefixItems"];
  if (Array.isArray(prefixItems)) {
    result["prefixItems"] = prefixItems.map((item) =>
      collapseSchemaNode(item, [...path, "*"], annotationsByPath),
    );
  }

  for (const combinator of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = node[combinator];
    if (Array.isArray(branches)) {
      result[combinator] = branches.map((branch) =>
        collapseSchemaNode(branch, path, annotationsByPath),
      );
    }
  }

  const defs = node["$defs"];
  if (isRecord(defs)) {
    result["$defs"] = Object.fromEntries(
      Object.entries(defs).map(([name, child]) => [
        name,
        // `$defs` members are keyed by ref name, not position, so `path` passes
        // through unchanged; neither generated document currently emits `$defs`,
        // so this is inert.
        collapseSchemaNode(child, path, annotationsByPath),
      ]),
    );
  }

  return result;
}

/**
 * Collapses every `anyOf: [{ type: "number", ... }, { type: "string", enum:
 * [subset of "Infinity"/"-Infinity"/"NaN"] }]` node in `document` down to the
 * plain `{ type: "number", ... }` branch, re-attaching `description`/`default`
 * from `rootAst` when the union node doesn't already carry them. `rootAst` must
 * be the same schema `document` was rendered from.
 */
export function collapseNonFiniteNumberUnions(document: unknown, rootAst: SchemaAST.AST): unknown {
  const annotationsByPath = collectNumberLeafAnnotations(rootAst);
  return collapseSchemaNode(document, [], annotationsByPath);
}

/**
 * Injects `$id`/`title`/`description` right after `$schema`, ahead of the
 * document's own keys. `metadata` is authoritative: any `$id`/`title`/
 * `description` already on `document` is discarded rather than allowed to win
 * via the trailing `...rest` spread.
 */
export function withSchemaMetadata(
  document: Record<string, unknown>,
  metadata: { readonly id: string; readonly title: string; readonly description: string },
): Record<string, unknown> {
  const { $schema, $id: _id, title: _title, description: _description, ...rest } = document;
  return {
    $schema,
    $id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    ...rest,
  };
}

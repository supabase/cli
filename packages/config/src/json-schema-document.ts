/**
 * Assembles a published JSON Schema document from a generated schema and its definitions.
 * Pattern-keyed records stay open: the generator now writes a boolean `additionalProperties`
 * on them (effect 4.0) and has no per-schema setting, while the published documents never
 * carried one there. Structs keep theirs.
 */
export function toPublishedJsonSchemaDocument(document: {
  readonly schema: Record<string, unknown>;
  readonly definitions: Record<string, unknown>;
}) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...openPatternKeyedRecords(document.schema),
    ...(Object.keys(document.definitions).length > 0
      ? { $defs: openPatternKeyedRecords(document.definitions) }
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
  return out as T;
}

function isRecordLike(node: Record<string, unknown>): boolean {
  const patternProperties = node["patternProperties"];
  return typeof patternProperties === "object" && patternProperties !== null;
}

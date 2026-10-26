import { Schema } from "effect";

/**
 * Renders a published JSON Schema document, carrying the `x-secret` marker through and keeping
 * pattern-keyed records open: the generator writes a boolean `additionalProperties` on them
 * (effect 4.0) with no per-schema setting, while the published documents never carried one there.
 */
export function toPublishedJsonSchemaDocument(
  schema: Schema.Constraint,
  options: { readonly onExcessProperty: "ignore" | "error" },
) {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: options.onExcessProperty,
    includeAnnotationKey: (key) => key === "x-secret",
  });
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

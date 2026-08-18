import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { LegacyDocsExample } from "./legacy-docs-spec.ts";

/**
 * Loads the docs-spec content inputs from `apps/cli/docs/`: the description
 * overlay markdown under `supabase/` (keyed by docs-relative POSIX path, the
 * same keys `legacyDocsOverlayPath` produces on every platform) and the
 * per-command examples from `templates/examples.yaml` (keyed by doc id).
 * Shared by the generator (`scripts/generate-docs-spec.ts`) and the unit
 * tests.
 */
export interface LegacyDocsContent {
  readonly overlays: ReadonlyMap<string, string>;
  readonly examples: Readonly<Record<string, ReadonlyArray<LegacyDocsExample>>>;
}

export function legacyReadDocsContent(docsDir: string): LegacyDocsContent {
  const overlays = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith(".md")) {
        const key = path.relative(docsDir, entryPath).split(path.sep).join("/");
        overlays.set(key, readFileSync(entryPath, "utf8"));
      }
    }
  };
  walk(path.join(docsDir, "supabase"));

  const examplesPath = path.join(docsDir, "templates/examples.yaml");
  return { overlays, examples: legacyParseExamples(parse(readFileSync(examplesPath, "utf8"))) };
}

/**
 * Narrows the parsed `examples.yaml` document to its expected shape — a
 * mapping of doc id to example entries with optional string fields — failing
 * with the offending doc id instead of letting a malformed file flow into
 * the published spec.
 */
function legacyParseExamples(
  parsed: unknown,
): Readonly<Record<string, ReadonlyArray<LegacyDocsExample>>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("legacy-docs-spec.content.ts: examples.yaml must be a mapping of doc ids.");
  }
  const examples: Record<string, ReadonlyArray<LegacyDocsExample>> = {};
  for (const [docId, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) {
      throw new Error(
        `legacy-docs-spec.content.ts: examples.yaml entry "${docId}" must be a list of examples.`,
      );
    }
    examples[docId] = entries.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(
          `legacy-docs-spec.content.ts: examples.yaml entry "${docId}"[${index}] must be a mapping.`,
        );
      }
      const fields = new Map<string, unknown>(Object.entries(entry));
      for (const key of fields.keys()) {
        if (key !== "id" && key !== "name" && key !== "code" && key !== "response") {
          throw new Error(
            `legacy-docs-spec.content.ts: examples.yaml "${docId}"[${index}] has unknown field "${key}" — allowed fields are id, name, code, response.`,
          );
        }
      }
      return {
        ...legacyOptionalString(docId, index, fields, "id"),
        ...legacyOptionalString(docId, index, fields, "name"),
        ...legacyOptionalString(docId, index, fields, "code"),
        ...legacyOptionalString(docId, index, fields, "response"),
      };
    });
  }
  return examples;
}

function legacyOptionalString(
  docId: string,
  index: number,
  fields: ReadonlyMap<string, unknown>,
  field: "id" | "name" | "code" | "response",
): Partial<Record<"id" | "name" | "code" | "response", string>> {
  if (!fields.has(field)) return {};
  const value = fields.get(field);
  if (typeof value !== "string") {
    throw new Error(
      `legacy-docs-spec.content.ts: examples.yaml "${docId}"[${index}].${field} must be a string.`,
    );
  }
  return { [field]: value };
}

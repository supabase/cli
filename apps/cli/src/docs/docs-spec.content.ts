import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { DocsExample } from "./docs-spec.ts";

/**
 * Loads the docs-spec content inputs from `apps/cli/docs/`: description overlay markdown
 * under `supabase/` (keyed by docs-relative POSIX path) and per-command examples from
 * `templates/examples.yaml` (keyed by doc id). Shared by the generator
 * (`scripts/generate-docs-spec.ts`) and the unit tests.
 */
export interface DocsContent {
  readonly overlays: ReadonlyMap<string, string>;
  readonly examples: Readonly<Record<string, ReadonlyArray<DocsExample>>>;
}

export function readDocsContent(docsDir: string): DocsContent {
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
  return { overlays, examples: parseExamples(parse(readFileSync(examplesPath, "utf8"))) };
}

/**
 * Narrows the parsed `examples.yaml` document to its expected shape — a mapping of doc id to
 * example entries with optional string fields — failing with the offending doc id instead of
 * letting a malformed file flow into the published spec.
 */
function parseExamples(parsed: unknown): Readonly<Record<string, ReadonlyArray<DocsExample>>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("docs-spec.content.ts: examples.yaml must be a mapping of doc ids.");
  }
  const examples: Record<string, ReadonlyArray<DocsExample>> = {};
  for (const [docId, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) {
      throw new Error(
        `docs-spec.content.ts: examples.yaml entry "${docId}" must be a list of examples.`,
      );
    }
    examples[docId] = entries.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(
          `docs-spec.content.ts: examples.yaml entry "${docId}"[${index}] must be a mapping.`,
        );
      }
      const fields = new Map<string, unknown>(Object.entries(entry));
      for (const key of fields.keys()) {
        if (key !== "id" && key !== "name" && key !== "code" && key !== "response") {
          throw new Error(
            `docs-spec.content.ts: examples.yaml "${docId}"[${index}] has unknown field "${key}" — allowed fields are id, name, code, response.`,
          );
        }
      }
      return {
        ...optionalString(docId, index, fields, "id"),
        ...optionalString(docId, index, fields, "name"),
        ...optionalString(docId, index, fields, "code"),
        ...optionalString(docId, index, fields, "response"),
      };
    });
  }
  return examples;
}

function optionalString(
  docId: string,
  index: number,
  fields: ReadonlyMap<string, unknown>,
  field: "id" | "name" | "code" | "response",
): Partial<Record<"id" | "name" | "code" | "response", string>> {
  if (!fields.has(field)) return {};
  const value = fields.get(field);
  if (typeof value !== "string") {
    throw new Error(
      `docs-spec.content.ts: examples.yaml "${docId}"[${index}].${field} must be a string.`,
    );
  }
  return { [field]: value };
}

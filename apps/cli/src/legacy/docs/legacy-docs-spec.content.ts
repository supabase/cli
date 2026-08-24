import { Data, Effect, FileSystem, Path } from "effect";
import type * as PlatformError from "effect/PlatformError";
import { parse } from "yaml";
import type { LegacyDocsExample } from "./legacy-docs-spec.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

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

export class LegacyDocsContentParseError extends Data.TaggedError("LegacyDocsContentParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export function legacyReadDocsContent(
  docsDir: string,
): Effect.Effect<
  LegacyDocsContent,
  PlatformError.PlatformError | LegacyDocsContentParseError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const overlays = new Map<string, string>();
    const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(dir);
        for (const name of entries) {
          const entryPath = path.join(dir, name);
          const info = yield* fs.stat(entryPath);
          if (info.type === "Directory") {
            yield* walk(entryPath);
          } else if (name.endsWith(".md")) {
            const key = path.relative(docsDir, entryPath).split(path.sep).join("/");
            overlays.set(key, yield* fs.readFileString(entryPath));
          }
        }
      });
    yield* walk(path.join(docsDir, "supabase"));
    const examplesPath = path.join(docsDir, "templates/examples.yaml");
    const examplesText = yield* fs.readFileString(examplesPath);
    const examples = yield* Effect.try({
      try: () => parse(examplesText),
      catch: (cause) =>
        new LegacyDocsContentParseError({
          message: String(cause),
        }),
    });
    return yield* Effect.try({
      try: () => ({ overlays, examples: legacyParseExamples(examples) }),
      catch: (cause) =>
        new LegacyDocsContentParseError({
          message: String(cause),
        }),
    });
  });
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

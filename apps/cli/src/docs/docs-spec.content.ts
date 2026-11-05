import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { parse } from "yaml";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { DocsExample } from "./docs-spec.ts";

/**
 * Loads the docs-spec content inputs from `apps/cli/docs/`: description overlay markdown
 * under `supabase/` (keyed by docs-relative POSIX path) and per-command examples from
 * `templates/examples.yaml` (keyed by doc id). Shared by the generator
 * (`scripts/generate-docs-spec.ts`) and the unit tests.
 */
export interface DocsContent {
  readonly overlays: ReadonlyMap<string, string>;
  readonly examples: Readonly<Record<string, ReadonlyArray<DocsExampleSource>>>;
}

/**
 * An `examples.yaml` entry: the published example plus whether its `response` is `recorded`
 * from a run in `scenario`, as `CommandDocs` examples declare it. Only the published fields ship.
 */
export interface DocsExampleSource extends DocsExample {
  readonly output?: "recorded" | "illustrative";
  readonly scenario?: string;
}

const EXAMPLE_FIELDS = ["id", "name", "code", "response", "output", "scenario"] as const;
type ExampleField = (typeof EXAMPLE_FIELDS)[number];
const isExampleField = (key: string): key is ExampleField =>
  EXAMPLE_FIELDS.some((field) => field === key);

/** Fails `readDocsContent` when `templates/examples.yaml` is not valid YAML or not the expected shape. */
export class DocsExamplesError extends Schema.TaggedError<DocsExamplesError>()(
  "DocsExamplesError",
  { message: Schema.String, cause: Schema.Defect() },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export const readDocsContent = Effect.fn("docs.readDocsContent")(function* (
  docsDir: string,
): Effect.fn.Return<
  DocsContent,
  PlatformError | DocsExamplesError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /* Keeps a leading BOM, which `readFileString` strips. */
  const readUtf8 = (file: string) =>
    Effect.map(fs.readFile(file), (bytes) =>
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    );
  /* Never walks a symlink, even one `readLink` is denied on (a mode-000 link on macOS); an entry
     `readLink` or `stat` cannot reach counts as a file, so a `.md` one still fails on its read. */
  const isWalkableDirectory = Effect.fnUntraced(function* (entryPath: string) {
    const isSymlinkOrDenied = yield* fs.readLink(entryPath).pipe(
      Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.void),
      Effect.isSuccess,
    );
    if (isSymlinkOrDenied) return false;
    return yield* Effect.match(fs.stat(entryPath), {
      onFailure: () => false,
      onSuccess: (info) => info.type === "Directory",
    });
  });
  const overlays = new Map<string, string>();
  const walk = (dir: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(dir)) {
        const entryPath = path.join(dir, name);
        if (yield* isWalkableDirectory(entryPath)) yield* walk(entryPath);
        else if (name.endsWith(".md")) {
          const key = path.relative(docsDir, entryPath).split(path.sep).join("/");
          overlays.set(key, yield* readUtf8(entryPath));
        }
      }
    });
  yield* walk(path.join(docsDir, "supabase"));

  const examplesPath = path.join(docsDir, "templates/examples.yaml");
  const text = yield* readUtf8(examplesPath);
  const examples = yield* Effect.try({
    try: () => parseExamples(parse(text)),
    catch: (cause) =>
      new DocsExamplesError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  return { overlays, examples };
});

/**
 * Narrows the parsed `examples.yaml` document to its expected shape — a mapping of doc id to
 * example entries with optional string fields — failing with the offending doc id instead of
 * letting a malformed file flow into the published spec.
 */
function parseExamples(
  parsed: unknown,
): Readonly<Record<string, ReadonlyArray<DocsExampleSource>>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("docs-spec.content.ts: examples.yaml must be a mapping of doc ids.");
  }
  const examples: Record<string, ReadonlyArray<DocsExampleSource>> = {};
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
        if (!isExampleField(key)) {
          throw new Error(
            `docs-spec.content.ts: examples.yaml "${docId}"[${index}] has unknown field "${key}" — allowed fields are ${EXAMPLE_FIELDS.join(", ")}.`,
          );
        }
      }
      const output = fields.get("output");
      if (output !== undefined && output !== "recorded" && output !== "illustrative") {
        throw new Error(
          `docs-spec.content.ts: examples.yaml "${docId}"[${index}].output must be recorded or illustrative.`,
        );
      }
      if (output === "recorded" && (!fields.has("scenario") || !fields.has("response"))) {
        throw new Error(
          `docs-spec.content.ts: examples.yaml "${docId}"[${index}] is recorded, so it needs a scenario and a response.`,
        );
      }
      return {
        ...optionalString(docId, index, fields, "id"),
        ...optionalString(docId, index, fields, "name"),
        ...optionalString(docId, index, fields, "code"),
        ...optionalString(docId, index, fields, "response"),
        ...(output === undefined ? {} : { output }),
        ...optionalString(docId, index, fields, "scenario"),
      };
    });
  }
  return examples;
}

function optionalString(
  docId: string,
  index: number,
  fields: ReadonlyMap<string, unknown>,
  field: Exclude<ExampleField, "output">,
): Partial<Record<Exclude<ExampleField, "output">, string>> {
  if (!fields.has(field)) return {};
  const value = fields.get(field);
  if (typeof value !== "string") {
    throw new Error(
      `docs-spec.content.ts: examples.yaml "${docId}"[${index}].${field} must be a string.`,
    );
  }
  return { [field]: value };
}

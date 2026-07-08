import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest (via Vite) provides `import.meta.glob` at runtime; the workspace
// tsconfig does not load `vite/client`, so declare the one member we use.
declare global {
  interface ImportMeta {
    readonly glob: (patterns: ReadonlyArray<string>) => Record<string, () => Promise<unknown>>;
  }
}
import {
  CliErrorCategory,
  CliErrorKind,
  CliSuggestionType,
  ErrorActionabilityId,
  isClassifiedExternalErrorTag,
} from "./error-actionability.ts";

/**
 * Drift guard for the error actionability taxonomy: every error class defined
 * in `apps/cli/src` must declare its own classification under
 * {@link ErrorActionabilityId}, and every error tag defined in the workspace
 * packages that can surface through CLI commands must have an external
 * adapter. A new error type failing here is the feature — `unknown` in
 * production telemetry must mean "genuinely unforeseen failure", never "we
 * forgot to classify".
 */

const ERROR_DEFINITION_PATTERN =
  /(?:TaggedError|CliError)\(\s*"([A-Za-z0-9_]+)"|class\s+([A-Za-z0-9_]+)\s+extends\s+Error\b/gs;

function scanErrorTags(root: string): Map<string, Array<string>> {
  const tagsByFile = new Map<string, Array<string>>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
      const tags = [...readFileSync(path, "utf8").matchAll(ERROR_DEFINITION_PATTERN)].map(
        (match) => match[1] ?? match[2] ?? "",
      );
      if (tags.length > 0) tagsByFile.set(path, tags);
    }
  };
  walk(root);
  return tagsByFile;
}

const kindValues = new Set<string>(Object.values(CliErrorKind));
const categoryValues = new Set<string>(Object.values(CliErrorCategory));
const suggestionValues = new Set<string>(Object.values(CliSuggestionType));

interface DeclaredErrorClass {
  readonly exportName: string;
  readonly tag: string;
  readonly prototype: object;
}

function collectErrorClasses(module: Record<string, unknown>): Array<DeclaredErrorClass> {
  const classes: Array<DeclaredErrorClass> = [];
  for (const [exportName, value] of Object.entries(module)) {
    if (typeof value !== "function") continue;
    const prototype: unknown = value.prototype;
    if (typeof prototype !== "object" || prototype === null) continue;
    if (!(prototype instanceof Error)) continue;
    // effect V4 assigns `_tag` per instance, so probe with an empty props bag.
    // Plain `extends Error` classes have no `_tag`; identify them by class name.
    let tag: unknown;
    try {
      tag = Reflect.get(Reflect.construct(value, [{}]), "_tag");
    } catch {
      tag = undefined;
    }
    classes.push({ exportName, tag: typeof tag === "string" ? tag : exportName, prototype });
  }
  return classes;
}

const srcRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(import.meta.dirname, "../../../../..");

const moduleLoaders = new Map(
  Object.entries(import.meta.glob(["../../**/*.ts", "!**/*.test.ts"])).map(([key, loader]) => [
    resolve(import.meta.dirname, key),
    loader,
  ]),
);

describe("apps/cli error classes declare their actionability", () => {
  const tagsByFile = scanErrorTags(srcRoot);

  it("finds the error definition surface", () => {
    expect(tagsByFile.size).toBeGreaterThan(50);
  });

  for (const [file, tags] of tagsByFile) {
    const relativePath = file.slice(srcRoot.length + 1);
    // Importing a command module can pull in a large transitive graph on first
    // load; give these dynamic-import tests more headroom than the default 5s.
    it(relativePath, { timeout: 30_000 }, async () => {
      const loader = moduleLoaders.get(file);
      expect(loader, `no module loader for ${relativePath}`).toBeDefined();
      const module = await loader?.();
      expect(typeof module).toBe("object");
      const classes = collectErrorClasses(Object(module));

      const exportedTags = new Set(classes.map((cls) => cls.tag));
      for (const tag of tags) {
        expect(
          exportedTags.has(tag),
          `error "${tag}" is defined in ${relativePath} but not exported — export it so its actionability declaration is verifiable`,
        ).toBe(true);
      }

      for (const { exportName, tag, prototype } of classes) {
        expect(
          ErrorActionabilityId in prototype,
          `${exportName} ("${tag}") does not declare [ErrorActionabilityId] — add a getter returning its CliErrorActionabilityDeclaration`,
        ).toBe(true);

        // Evaluate the getter against a field-less probe: instance-dependent
        // declarations must degrade to a valid declaration when fields are
        // absent, and static ones are checked directly.
        const probe: object = Object.create(prototype);
        const declaration: unknown = Reflect.get(probe, ErrorActionabilityId);
        expect(
          typeof declaration === "object" && declaration !== null,
          `${exportName} ("${tag}") declaration is not an object`,
        ).toBe(true);
        const record: Record<string, unknown> = Object(declaration);
        expect(kindValues.has(String(record["error_kind"]))).toBe(true);
        expect(categoryValues.has(String(record["error_category"]))).toBe(true);
        expect(typeof record["has_suggestion"]).toBe("boolean");
        expect(suggestionValues.has(String(record["suggestion_type"]))).toBe(true);
      }
    });
  }
});

describe("workspace package error tags have external adapters", () => {
  const packageRoots = [
    "packages/stack/src",
    "packages/config/src",
    "packages/process-compose/src",
  ];

  for (const packageRoot of packageRoots) {
    it(packageRoot, () => {
      const tagsByFile = scanErrorTags(resolve(repoRoot, packageRoot));
      expect(tagsByFile.size).toBeGreaterThan(0);
      for (const [file, tags] of tagsByFile) {
        for (const tag of tags) {
          expect(
            isClassifiedExternalErrorTag(tag),
            `"${tag}" (${file.slice(repoRoot.length + 1)}) has no external adapter in error-actionability.ts`,
          ).toBe(true);
        }
      }
    });
  }
});

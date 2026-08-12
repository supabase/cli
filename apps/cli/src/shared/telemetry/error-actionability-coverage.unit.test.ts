import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "effect/unstable/cli";

// Vitest (via Vite) provides `import.meta.glob` at runtime; the workspace
// tsconfig does not load `vite/client`, so declare the one member we use.
declare global {
  interface ImportMeta {
    readonly glob: (patterns: ReadonlyArray<string>) => Record<string, () => Promise<unknown>>;
  }
}
import { MANAGED_ERROR_CODES, MANAGED_ERROR_TAG_BY_CODE } from "@supabase/stack/managed-model";
import {
  CliErrorCategory,
  CliErrorKind,
  CliSuggestionType,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
  isClassifiedExternalErrorTag,
  isClassifiedManagedErrorCode,
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

// Matches every way an error class is defined in this workspace: direct
// `Data.TaggedError("Tag")`, any local `*Error(...)` factory whose heritage
// call carries the tag literal (`CliError("Tag")`, `LoginError("Tag")`, ...),
// and plain `extends Error` classes (identified by class name). Error
// factories must therefore be named `<Something>Error` to stay guarded —
// which also keeps `Data.TaggedClass` event types out of the scan.
const ERROR_DEFINITION_PATTERN =
  /TaggedError\(\s*"([A-Za-z0-9_]+)"|class\s+[A-Za-z0-9_]+\s+extends\s+[A-Za-z0-9_.]*Error\(\s*"([A-Za-z0-9_]+)"|class\s+([A-Za-z0-9_]+)\s+extends\s+Error\b/gs;

// Removes `//` line comments and `/* */` block comments from a source string
// so the regex-based scan below never mistakes a comment merely mentioning
// `class X extends Error` (or a TaggedError example) for a real definition.
// String and template literals are treated as opaque runs — a `//` or `/*`
// inside `"https://..."` (or a backtick template) must survive untouched.
// Stripped comment bytes are replaced with spaces (newlines are preserved)
// so line numbers and any line-based logic elsewhere stay unaffected. This
// is a compact scanner, not a full tokenizer: it does not special-case regex
// literals or `${...}` interpolation inside template literals.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const ch = source[i];
        out += ch;
        i += 1;
        if (ch === "\\" && i < n) {
          out += source[i];
          i += 1;
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

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
      const tags = [
        ...stripComments(readFileSync(path, "utf8")).matchAll(ERROR_DEFINITION_PATTERN),
      ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
      if (tags.length > 0) tagsByFile.set(path, tags);
    }
  };
  walk(root);
  return tagsByFile;
}

// Extracts the error tags a snippet of source would contribute to the scan,
// mirroring the comment-stripping + matching pipeline `scanErrorTags` runs
// against real files, without touching the filesystem.
function extractErrorTags(source: string): Array<string> {
  return [...stripComments(source).matchAll(ERROR_DEFINITION_PATTERN)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

describe("stripComments", () => {
  it("removes a line comment mentioning a fake error class", () => {
    const source = "// class Fake extends Error\nconst x = 1;";
    expect(extractErrorTags(source)).toEqual([]);
  });

  it("removes a block comment mentioning a fake TaggedError example", () => {
    const source = '/* e.g. Data.TaggedError("FakeTag") */\nconst x = 1;';
    expect(extractErrorTags(source)).toEqual([]);
  });

  it("removes a block comment spanning multiple lines", () => {
    const source = [
      "/*",
      " * class AlsoFake extends Error",
      ' * Data.TaggedError("AlsoFakeTag")',
      " */",
      "const x = 1;",
    ].join("\n");
    expect(extractErrorTags(source)).toEqual([]);
  });

  it("keeps a string literal containing `//` intact and still finds a real definition after it", () => {
    const source = [
      'const url = "https://example.com/foo";',
      "export class RealError extends Error {}",
    ].join("\n");
    expect(extractErrorTags(source)).toEqual(["RealError"]);
  });

  it("keeps a template literal containing `//` intact and still finds a real definition after it", () => {
    const source = [
      "const url = `https://example.com/${path}`;",
      'export class TemplateError extends Data.TaggedError("TemplateError") {}',
    ].join("\n");
    expect(extractErrorTags(source)).toEqual(["TemplateError"]);
  });

  it("still finds a real definition that follows a comment about a fake one", () => {
    const source = [
      "// This looks like a class Fake extends Error but is not",
      'export class RealTaggedError extends Data.TaggedError("RealTaggedError") {}',
    ].join("\n");
    expect(extractErrorTags(source)).toEqual(["RealTaggedError"]);
  });
});

const kindValues = new Set<string>(Object.values(CliErrorKind));
const categoryValues = new Set<string>(Object.values(CliErrorCategory));
const suggestionValues = new Set<string>(Object.values(CliSuggestionType));

interface DeclaredErrorClass {
  readonly constructor: object;
  readonly exportName: string;
  readonly isTagged: boolean;
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
    classes.push({
      constructor: value,
      exportName,
      isTagged: typeof tag === "string",
      tag: typeof tag === "string" ? tag : exportName,
      prototype,
    });
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

      for (const { constructor, exportName, isTagged, tag, prototype } of classes) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, ErrorActionabilityId);
        expect(
          typeof descriptor?.get,
          `${exportName} ("${tag}") does not declare an own [ErrorActionabilityId] getter — add one returning its CliErrorActionabilityDeclaration`,
        ).toBe("function");

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

        if (!isTagged) {
          const fingerprintDescriptor = Object.getOwnPropertyDescriptor(
            constructor,
            ErrorActionabilityFingerprintId,
          );
          expect(
            fingerprintDescriptor !== undefined &&
              "value" in fingerprintDescriptor &&
              fingerprintDescriptor.value === exportName,
            `${exportName} is an untagged Error and must declare its stable source identifier as an own static [ErrorActionabilityFingerprintId] value`,
          ).toBe(true);
        }
      }
    });
  }
});

describe("workspace package error tags have external adapters", () => {
  const packageRoots = [
    "packages/api/src",
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

// Managed failures are tagged errors that also declare a stable `code`, and the
// CLI's dispatch table is generated from the package's tag/code map. The
// generic scan above already requires an adapter for each tag; this guard is
// what keeps the two halves of the contract joined — the (class, tag, code)
// triples in the model must agree with the exported map, the code list, and the
// code-keyed classification table.
const MANAGED_TAGGED_CLASS_PATTERN =
  /class\s+([A-Za-z0-9_]+)\s+extends\s+Data\.TaggedError\(\s*"([A-Za-z0-9_]+)",?\s*\)[\s\S]*?readonly\s+code\s*=\s*"([A-Z0-9_]+)"/g;

describe("managed registry error codes are classified", () => {
  it("packages/stack/src/managed/model.ts", () => {
    const modelPath = resolve(repoRoot, "packages/stack/src/managed/model.ts");
    const matches = [...readFileSync(modelPath, "utf8").matchAll(MANAGED_TAGGED_CLASS_PATTERN)];
    // One match per declared code: a class written in a shape this regex cannot
    // see would otherwise pass vacuously instead of failing loudly.
    expect(matches.length).toBe(MANAGED_ERROR_CODES.length);
    const declaredCodes = new Set<string>(MANAGED_ERROR_CODES);
    const scannedCodes = new Set<string>();
    for (const match of matches) {
      const className = match[1] ?? "";
      const tag = match[2] ?? "";
      const code = match[3] ?? "";
      scannedCodes.add(code);
      expect(tag, `${className} is tagged "${tag}" rather than its own export name`).toBe(
        className,
      );
      expect(
        declaredCodes.has(code),
        `${className}'s code "${code}" is missing from MANAGED_ERROR_CODES`,
      ).toBe(true);
      expect(
        Reflect.get(MANAGED_ERROR_TAG_BY_CODE, code),
        `MANAGED_ERROR_TAG_BY_CODE does not map "${code}" to ${className}`,
      ).toBe(tag);
      expect(
        isClassifiedManagedErrorCode(code),
        `${className} ("${code}") has no entry in managedActionabilityByCode in error-actionability.ts`,
      ).toBe(true);
      expect(
        isClassifiedExternalErrorTag(tag),
        `${className} ("${tag}") has no generated entry in externalActionabilityByTag in error-actionability.ts`,
      ).toBe(true);
    }
    // Every declared code is backed by a class, not just the other way round.
    expect([...scannedCodes].sort()).toEqual([...declaredCodes].sort());
  });
});

describe("Effect CLI parser errors have exhaustive handling", () => {
  it("covers every exported parser error class", () => {
    const tags = new Set<string>();
    const probe = {
      option: "--probe",
      command: [],
      suggestions: [],
      parentCommand: "parent",
      childCommand: "child",
      argument: "argument",
      arguments: [],
      value: "value",
      expected: "expected",
      kind: "flag",
      subcommand: "subcommand",
      parent: [],
      cause: new Error("probe"),
      commandPath: [],
      errors: [],
    };

    for (const value of Object.values(CliError)) {
      if (typeof value !== "function") continue;
      const prototype: unknown = value.prototype;
      if (typeof prototype !== "object" || prototype === null) continue;
      if (!(prototype instanceof Error)) continue;

      try {
        const tag = Reflect.get(Reflect.construct(value, [probe]), "_tag");
        if (typeof tag === "string") tags.add(tag);
      } catch {
        // Non-error exports and constructors that require runtime setup are
        // outside the parser error union checked at compile time by the map.
      }
    }

    expect(tags.size).toBeGreaterThan(5);
    for (const tag of tags) {
      expect(
        tag === "ShowHelp" || tag === "UserError" || isClassifiedExternalErrorTag(tag),
        `Effect CLI parser error "${tag}" has no actionability handling`,
      ).toBe(true);
    }
  });
});

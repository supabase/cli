import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import type { ClassLikeDeclaration, Expression, Node, SourceFile } from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/async";
import { afterAll, describe, expect, it } from "vitest";
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

// The scan below recognizes every way an error class is defined in this
// workspace: direct `Data.TaggedError("Tag")`, any local `*Error(...)` factory
// whose heritage call carries the tag literal (`CliError("Tag")`,
// `LoginError("Tag")`, ...), and plain `extends Error` classes (identified by
// class name). Error factories must therefore be named `<Something>Error` to
// stay guarded — which also keeps `Data.TaggedClass` event types out of the
// scan. It runs on a real TypeScript AST rather than on text, so a definition
// merely *mentioned* in a comment, a string, or a template literal is
// structurally invisible and needs no special casing.

// The simple name of a call's callee: `TaggedError` for both `TaggedError(...)`
// and `Data.TaggedError(...)`.
const parserFileSystem = createVirtualFileSystem({});
const parserApi = new API({ cwd: process.cwd(), fs: parserFileSystem });

afterAll(() => parserApi.close());

function calleeName(expression: Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

// The value of a plain string literal, seeing through an `as const` assertion
// (`readonly code = "X" as const`). A computed or interpolated string cannot be
// resolved statically, and none exists in this workspace.
function stringLiteralText(expression: Expression | undefined): string | undefined {
  const inner =
    expression !== undefined && ts.isAsExpression(expression) ? expression.expression : expression;
  return inner !== undefined && ts.isStringLiteral(inner) ? inner.text : undefined;
}

function extendsExpression(node: ClassLikeDeclaration): Expression | undefined {
  const clause = node.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
  return clause?.types[0]?.expression;
}

async function withParsedSources<T>(
  sources: ReadonlyArray<readonly [fileName: string, source: string]>,
  visit: (files: ReadonlyMap<string, SourceFile>) => T,
): Promise<T> {
  const normalizedSources = sources.map(
    ([fileName, source]) => [resolve(fileName), source] as const,
  );
  for (const [fileName, source] of normalizedSources)
    parserFileSystem.writeFile?.(fileName, source);
  const snapshot = await parserApi.updateSnapshot({
    openFiles: normalizedSources.map(([fileName]) => fileName),
    fileChanges: { changed: normalizedSources.map(([fileName]) => fileName) },
  });
  try {
    const files = new Map<string, SourceFile>();
    for (const [index, [originalFileName]] of sources.entries()) {
      const normalized = normalizedSources[index];
      if (normalized === undefined) throw new Error(`failed to normalize ${originalFileName}`);
      const [fileName] = normalized;
      const project = await snapshot.getDefaultProjectForFile(fileName);
      const sourceFile = await project?.program.getSourceFile(fileName);
      if (sourceFile === undefined) throw new Error(`failed to parse ${fileName}`);
      files.set(originalFileName, sourceFile);
    }
    return visit(files);
  } finally {
    await snapshot.dispose();
  }
}

async function withParsedSource<T>(
  fileName: string,
  source: string,
  visit: (file: SourceFile) => T,
): Promise<T> {
  return withParsedSources([[fileName, source]], (files) => visit(files.get(fileName)!));
}

function hasExportModifier(node: ClassLikeDeclaration): boolean {
  return node.modifiers?.some((modifier) => ts.isExportKeyword(modifier)) === true;
}

// Extracts the error identifiers a source file defines: the tag literal of
// every `class X extends <Something>Error("Tag")` heritage call and of every
// free-standing `TaggedError("Tag")` factory call, plus the class name of
// every plain `class X extends Error` (untagged classes are fingerprinted by
// name). A tagged class contributes its tag once — the heritage call is
// claimed by the class rule so the factory rule does not count it again.
function extractErrorTagsFromFile(
  sourceFile: SourceFile,
  options: { readonly exportedOnly?: boolean },
): Array<string> {
  const tags: Array<string> = [];
  const claimed = new Set<Node>();

  const visit = (node: Node): void => {
    if (ts.isClassLikeDeclaration(node)) {
      const heritage = extendsExpression(node);
      if (heritage !== undefined && ts.isCallExpression(heritage)) {
        const tag = calleeName(heritage.expression).endsWith("Error")
          ? stringLiteralText(heritage.arguments[0])
          : undefined;
        if (tag !== undefined) {
          if (!options.exportedOnly || hasExportModifier(node)) tags.push(tag);
          claimed.add(heritage);
        }
      } else if (
        heritage !== undefined &&
        ts.isIdentifier(heritage) &&
        heritage.text === "Error" &&
        node.name !== undefined
      ) {
        if (!options.exportedOnly || hasExportModifier(node)) tags.push(node.name.text);
      }
    }

    if (
      ts.isCallExpression(node) &&
      !claimed.has(node) &&
      calleeName(node.expression).endsWith("TaggedError")
    ) {
      const tag = stringLiteralText(node.arguments[0]);
      if (tag !== undefined) tags.push(tag);
    }

    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);
  return tags;
}

// Parse the focused AST fixtures once, before Vitest starts scheduling the
// module-import checks below. Keeping these assertions synchronous avoids
// competing for the shared TypeScript project service while those imports are
// exercising the full CLI module graph under load.
const extractedTestTags = await withParsedSources(
  [
    [
      "definitions.ts",
      [
        'export class TaggedThingError extends Data.TaggedError("TaggedThingError") {}',
        'export class FactoryThingError extends CliError("FactoryTag") {}',
        "export class PlainThingError extends Error {}",
        'const Base = Data.TaggedError("FreeStandingTag");',
      ].join("\n"),
    ],
    [
      "comments.ts",
      [
        "// class Fake extends Error",
        '/* e.g. Data.TaggedError("FakeTag") */',
        "const x = 1;",
      ].join("\n"),
    ],
    [
      "literals.ts",
      [
        'const a = "class Fake extends Error";',
        'const b = `Data.TaggedError("FakeTag")`;',
        "const c = 'class AlsoFake extends Error';",
      ].join("\n"),
    ],
  ] as const,
  (files) =>
    new Map(
      ["definitions.ts", "comments.ts", "literals.ts"].map((fileName) => [
        fileName,
        extractErrorTagsFromFile(files.get(fileName)!, {}),
      ]),
    ),
);

async function scanErrorTags(
  root: string,
  options: { readonly exportedOnly?: boolean } = {},
): Promise<Map<string, Array<string>>> {
  const tagsByFile = new Map<string, Array<string>>();
  const sources: Array<readonly [string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
      sources.push([path, readFileSync(path, "utf8")]);
    }
  };
  walk(root);
  await withParsedSources(sources, (files) => {
    for (const [fileName, sourceFile] of files) {
      const tags = extractErrorTagsFromFile(sourceFile, options);
      if (tags.length > 0) tagsByFile.set(fileName, tags);
    }
  });
  return tagsByFile;
}

describe("extractErrorTags", () => {
  it("finds tagged, factory-tagged and plain error class definitions", () => {
    expect(extractedTestTags.get("definitions.ts")).toEqual([
      "TaggedThingError",
      "FactoryTag",
      "PlainThingError",
      "FreeStandingTag",
    ]);
  });

  it("ignores definitions that only appear in comments", () => {
    expect(extractedTestTags.get("comments.ts")).toEqual([]);
  });

  it("ignores definitions that only appear inside string and template literals", () => {
    expect(extractedTestTags.get("literals.ts")).toEqual([]);
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

const tagsByFile = await scanErrorTags(srcRoot);

describe("apps/cli error classes declare their actionability", () => {
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
  const packageRoots = ["packages/api/src", "packages/stack/src", "packages/config/src"];

  for (const packageRoot of packageRoots) {
    it(packageRoot, { timeout: 30_000 }, async () => {
      const tagsByFile = await scanErrorTags(resolve(repoRoot, packageRoot), {
        exportedOnly: true,
      });
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
interface ManagedErrorClass {
  readonly className: string;
  readonly tag: string;
  readonly code: string;
}

// Collects the (class, tag, code) triples of every `class X extends
// Data.TaggedError("Tag")` that also declares a string-literal `code` member.
async function scanManagedErrorClasses(path: string): Promise<Array<ManagedErrorClass>> {
  const classes: Array<ManagedErrorClass> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const heritage = extendsExpression(node);
      const tag =
        heritage !== undefined &&
        ts.isCallExpression(heritage) &&
        calleeName(heritage.expression) === "TaggedError"
          ? stringLiteralText(heritage.arguments[0])
          : undefined;
      const code = stringLiteralText(
        node.members
          .filter(ts.isPropertyDeclaration)
          .find((member) => ts.isIdentifier(member.name) && member.name.text === "code")
          ?.initializer,
      );
      if (tag !== undefined && code !== undefined) {
        classes.push({ className: node.name.text, tag, code });
      }
    }
    node.forEachChild(visit);
  };
  return withParsedSource(path, readFileSync(path, "utf8"), (sourceFile) => {
    sourceFile.forEachChild(visit);
    return classes;
  });
}

describe("managed registry error codes are classified", () => {
  it("packages/stack/src/managed/model.ts", async () => {
    const modelPath = resolve(repoRoot, "packages/stack/src/managed/model.ts");
    const scanned = await scanManagedErrorClasses(modelPath);
    // One class per declared code: a class written in a shape this scan cannot
    // see would otherwise pass vacuously instead of failing loudly.
    expect(scanned.length).toBe(MANAGED_ERROR_CODES.length);
    const declaredCodes = new Set<string>(MANAGED_ERROR_CODES);
    const scannedCodes = new Set<string>();
    for (const { className, tag, code } of scanned) {
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

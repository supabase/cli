import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as defaultEntrypoint from "./index.ts";
import * as effectEntrypoint from "./effect.ts";

// `src/index.ts` is the entrypoint Studio (a browser bundle) imports
// directly. It must stay bundlable with no Node/Bun runtime underneath it —
// no `@effect/platform-*` package, no `node:`/`bun:` builtin. Bare `effect`
// itself is fine to import: its `FileSystem`/`Path` Context.Tag references
// are inert data until a platform `Layer` actually provides them, which only
// `src/bun.ts`/`src/node.ts` (via `@supabase/config/io`) and `src/effect.ts`
// do. This test statically walks the entrypoint's real relative import graph
// so a future edit that reintroduces a platform/IO dependency into that graph
// fails here instead of silently breaking browser bundling downstream.

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(srcDir, "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly exports: {
    readonly ".": string;
    readonly "./io": Readonly<Record<string, string>>;
    readonly "./effect": string;
    readonly "./schema.json": string;
  };
};

const allowedBareSpecifier = (specifier: string): boolean =>
  specifier === "effect" ||
  specifier.startsWith("effect/") ||
  specifier === "smol-toml" ||
  specifier === "dedent";

// Relative specifiers in this package always carry an explicit `.ts`
// extension, so a resolved path never needs extension probing. The
// lookbehind excludes an occurrence of the word "from" that is itself the
// entire contents of a quoted string argument (e.g. `missing("vonage",
// "from")` in auth/sms.ts) — a real `from` clause is never immediately
// preceded by a quote character.
const fromClauseSpecifier = /(?<!["'])\bfrom\b\s*["']([^"']+)["']/g;
const sideEffectImportSpecifier = /^\s*import\s*["']([^"']+)["']\s*;?\s*$/gm;
const dynamicImportOrRequireSpecifier = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
// A whole-statement `import type {...} from "..."` / `export type {...} from
// "..."` (or `import type Foo from "..."` / `export type * from "..."`) fully
// erases under `verbatimModuleSyntax` — unlike an inline `type` modifier on an
// individual specifier inside an otherwise-live import/export, which still
// emits a runtime `export {} from "..."`/import of the module. Blanking these
// statements out (preserving newlines, dropping everything else) before
// specifier extraction keeps the walked graph matching what actually reaches
// the bundler at runtime.
const typeOnlyImportExportStatement =
  /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']+["']\s*;?/g;

function blankOutTypeOnlyStatements(source: string): string {
  return source.replace(typeOnlyImportExportStatement, (match) => match.replace(/[^\n]/g, " "));
}

/**
 * Strips `//` line comments and `/* *\/` block comments, respecting string and
 * template literals so a URL like `"https://..."` is never mistaken for the
 * start of a line comment. Without this, a commented-out import, or a doc
 * comment mentioning a SQL `from "public"` clause as prose, would false-
 * positive as a real specifier.
 */
function stripComments(source: string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const twoChars = source.slice(index, index + 2);

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== quote) {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      cursor = Math.min(cursor + 1, source.length);
      result += source.slice(index, cursor);
      index = cursor;
      continue;
    }

    if (twoChars === "//") {
      const newlineIndex = source.indexOf("\n", index);
      index = newlineIndex === -1 ? source.length : newlineIndex;
      continue;
    }

    if (twoChars === "/*") {
      const closeIndex = source.indexOf("*/", index + 2);
      index = closeIndex === -1 ? source.length : closeIndex + 2;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function extractSpecifiers(rawSource: string): string[] {
  const source = blankOutTypeOnlyStatements(stripComments(rawSource));
  const specifiers: string[] = [];

  for (const pattern of [
    fromClauseSpecifier,
    sideEffectImportSpecifier,
    dynamicImportOrRequireSpecifier,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

function readSourceOrThrow(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `purity walker could not resolve ${file} (imported somewhere in the pure graph)`,
    );
  }
}

interface ImportGraph {
  readonly visitedFiles: ReadonlySet<string>;
  readonly bareSpecifiers: ReadonlySet<string>;
}

function collectImportGraph(entryFile: string): ImportGraph {
  const visitedFiles = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visitedFiles.has(file)) {
      continue;
    }
    visitedFiles.add(file);

    const source = readSourceOrThrow(file);

    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        queue.push(join(dirname(file), specifier));
      } else {
        bareSpecifiers.add(specifier);
      }
    }
  }

  return { visitedFiles, bareSpecifiers };
}

describe("extractSpecifiers", () => {
  test("extracts a dynamic import() specifier", () => {
    expect(extractSpecifiers(`const mod = await import("./dynamic-target.ts");`)).toEqual([
      "./dynamic-target.ts",
    ]);
  });

  test("extracts a require() specifier", () => {
    expect(extractSpecifiers(`const mod = require("./required-target.ts");`)).toEqual([
      "./required-target.ts",
    ]);
  });

  test("extracts a side-effect import", () => {
    expect(extractSpecifiers(`import "./side-effect.ts";`)).toEqual(["./side-effect.ts"]);
  });

  test("extracts a normal named import", () => {
    expect(extractSpecifiers(`import { foo } from "./foo.ts";`)).toEqual(["./foo.ts"]);
  });

  test("ignores a commented-out line-comment import", () => {
    expect(extractSpecifiers(`// import { foo } from "./foo.ts";`)).toEqual([]);
  });

  test("ignores a commented-out block-comment import", () => {
    expect(extractSpecifiers(`/* import { foo } from "./foo.ts"; */`)).toEqual([]);
  });

  test("ignores a doc-comment SQL example mentioning a quoted schema in a from clause", () => {
    const source = `
/**
 * Equivalent to \`select * from "public"."users"\`.
 */
export const x = 1;
`;
    expect(extractSpecifiers(source)).toEqual([]);
  });

  test("does not mistake a URL inside a string literal for a line comment", () => {
    const source = `export const link = "https://supabase.com/docs";\nimport { foo } from "./foo.ts";`;
    expect(extractSpecifiers(source)).toEqual(["./foo.ts"]);
  });

  test("ignores a whole-statement `import type {...} from` (fully erases under verbatimModuleSyntax)", () => {
    expect(extractSpecifiers(`import type { Foo } from "./types.ts";`)).toEqual([]);
  });

  test("ignores a whole-statement `export type {...} from` even across multiple lines", () => {
    const source = `export type {\n  Foo,\n  Bar,\n} from "./types.ts";`;
    expect(extractSpecifiers(source)).toEqual([]);
  });

  test("still extracts a mixed export with an inline `type` modifier on one specifier (does not fully erase)", () => {
    const source = `export { type Foo, bar } from "./mixed.ts";`;
    expect(extractSpecifiers(source)).toEqual(["./mixed.ts"]);
  });

  test("excludes a bare quoted 'from' string argument, not a real from-clause", () => {
    expect(extractSpecifiers(`missing("vonage", "from")`)).toEqual([]);
  });
});

describe("collectImportGraph", () => {
  test("throws a named error when a specifier cannot be resolved on disk", () => {
    const missingFile = join(srcDir, "__does-not-exist__.ts");
    expect(() => collectImportGraph(missingFile)).toThrow(
      `purity walker could not resolve ${missingFile} (imported somewhere in the pure graph)`,
    );
  });
});

const { visitedFiles, bareSpecifiers } = collectImportGraph(join(srcDir, "index.ts"));

// The real, post-partition pure runtime graph (CLI-2231): computed by running
// the walker above and hardcoded here so both additions AND removals are a
// deliberate, loud review event rather than silently passing or silently
// failing on an unrelated assertion.
const expectedPureGraphFiles = [
  "index.ts",
  "base.ts",
  "errors.ts",
  "config-document.ts",
  "functions-manifest-model.ts",
  "sparse.ts",
  "schema-metadata.ts",
  "tls.ts",
  "lib/env.ts",
  "lib/schema.ts",
  "analytics.ts",
  "api.ts",
  "auth/index.ts",
  "auth/captcha.ts",
  "auth/email.ts",
  "auth/hooks.ts",
  "auth/mfa.ts",
  "auth/providers.ts",
  "auth/rate_limit.ts",
  "auth/sessions.ts",
  "auth/sms.ts",
  "auth/third_party.ts",
  "auth/web3.ts",
  "db.ts",
  "edge_runtime.ts",
  "experimental.ts",
  "functions.ts",
  "inbucket.ts",
  "realtime.ts",
  "storage.ts",
  "studio.ts",
]
  .map((relativePath) => join(srcDir, relativePath))
  .sort();

describe("src/index.ts stays browser-safe", () => {
  test("the traversal actually walked the real module graph", () => {
    // Guards against the regex/traversal silently matching nothing (which
    // would make every assertion below vacuously true).
    expect(visitedFiles.size).toBeGreaterThan(1);
    expect(bareSpecifiers.has("effect")).toBe(true);
  });

  test("every bare import reachable from index.ts is on the browser-safe allowlist", () => {
    const disallowed = [...bareSpecifiers].filter((specifier) => !allowedBareSpecifier(specifier));

    expect(disallowed).toEqual([]);
  });

  test("the pure runtime graph is exactly the expected allowlist", () => {
    expect([...visitedFiles].sort()).toEqual(expectedPureGraphFiles);
  });
});

describe("src/index.ts export surface", () => {
  test("pins the exact set of runtime export names", () => {
    expect(Object.keys(defaultEntrypoint).sort()).toMatchInlineSnapshot(`
      [
        "DuplicateRemoteProjectIdError",
        "ENV_CAPTURE_REGEX",
        "InvalidRemoteProjectIdError",
        "KONG_LOCAL_CA_CERT",
        "MissingProjectConfigValueError",
        "PROJECT_CONFIG_SCHEMA_URL",
        "ProjectConfigParseError",
        "ProjectConfigSchema",
        "ProjectEnvParseError",
        "edgeFunctionDenoConfigFileName",
        "edgeFunctionEntrypointFileName",
        "edgeFunctionsDirectoryName",
        "encodeProjectConfigToJson",
        "encodeProjectConfigToToml",
        "getDefaultProjectConfig",
        "omitDefaultValues",
        "projectConfigValueSourceAt",
        "subtractProjectConfig",
        "toProjectConfigJsonSchema",
      ]
    `);
  });
});

describe("src/effect.ts is a superset of src/index.ts", () => {
  test("pins the exact set of runtime export names", () => {
    expect(Object.keys(effectEntrypoint).sort()).toMatchInlineSnapshot(`
      [
        "DuplicateRemoteProjectIdError",
        "ENV_CAPTURE_REGEX",
        "InvalidRemoteProjectIdError",
        "KONG_LOCAL_CA_CERT",
        "MissingProjectConfigValueError",
        "PROJECT_CONFIG_SCHEMA_URL",
        "ProjectConfigParseError",
        "ProjectConfigSchema",
        "ProjectConfigStore",
        "ProjectEnvParseError",
        "configJsonPath",
        "configTomlPath",
        "edgeFunctionDenoConfigFileName",
        "edgeFunctionEntrypointFileName",
        "edgeFunctionsDirectoryName",
        "encodeProjectConfigToJson",
        "encodeProjectConfigToToml",
        "findProjectPaths",
        "findProjectRoot",
        "getDefaultProjectConfig",
        "inferFunctionsManifest",
        "loadDotEnvFile",
        "loadProjectConfig",
        "loadProjectConfigFile",
        "loadProjectEnvironment",
        "omitDefaultValues",
        "projectConfigStoreLayer",
        "projectConfigValueSourceAt",
        "resolveProjectSubtree",
        "resolveProjectValue",
        "saveProjectConfig",
        "subtractProjectConfig",
        "toProjectConfigJsonSchema",
      ]
    `);
  });

  test("every runtime export key of index.ts is also exported by effect.ts, with an identical (not shadowed) binding", () => {
    const defaultKeys = Object.keys(defaultEntrypoint);

    // Guards against both namespace objects being empty due to a broken
    // import, which would otherwise make the loop below pass trivially.
    expect(defaultKeys.length).toBeGreaterThan(0);

    const mismatches = defaultKeys.flatMap((key) => {
      if (!(key in effectEntrypoint)) {
        return [`missing: ${key}`];
      }
      const defaultValue = (defaultEntrypoint as Record<string, unknown>)[key];
      const effectValue = (effectEntrypoint as Record<string, unknown>)[key];
      return effectValue === defaultValue ? [] : [`mismatched (shadowed): ${key}`];
    });

    expect(mismatches).toEqual([]);
  });
});

describe("package.json exports map", () => {
  test("./io exposes exactly the bun/node/browser/default conditions, in that order", () => {
    const ioExports = packageJson.exports["./io"];
    expect(Object.keys(ioExports)).toEqual(["bun", "node", "browser", "default"]);
  });

  test("every ./io condition target file exists on disk", () => {
    const ioExports = packageJson.exports["./io"];
    for (const target of Object.values(ioExports)) {
      expect(() => readFileSync(join(packageRoot, target))).not.toThrow();
    }
  });

  test("the '.' and './effect' export targets exist on disk", () => {
    // `./schema.json` is a build output (`dist/schema.json`) and intentionally
    // skipped here — it only exists after running `pnpm run build`.
    for (const key of [".", "./effect"] as const) {
      const target = packageJson.exports[key];
      expect(() => readFileSync(join(packageRoot, target))).not.toThrow();
    }
  });
});

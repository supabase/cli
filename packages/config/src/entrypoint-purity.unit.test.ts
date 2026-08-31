import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// This package's tests always run under Bun (`bun --bun vitest`, per
// `AGENTS.md`) — fail loudly here rather than letting a plain-node vitest
// run silently pass with an empty/broken walk.
if (typeof Bun === "undefined") {
  throw new Error("this test requires the Bun runtime");
}

// `Bun.Transpiler`'s import scanner replaces this file's previous hand-rolled
// comment-stripping/type-blanking/regex extraction, which had two reproduced
// false negatives: a template-literal dynamic import (``import(`./io.ts`)``)
// — the old specifier regex only matched quote characters — and a
// semicolon-less `export type Foo = number` statement swallowing the very
// next (real) import into its blanked-out range. `scanImports` is Bun's own
// TS/JSX-aware parser: it excludes type-only import/export statements,
// keeps a mixed inline-`type` specifier alive, and reports dynamic
// `import()`/`require()` calls (as `"dynamic-import"`/`"require-call"`)
// alongside ordinary `import ... from` statements — all verified against
// the fixtures in the `describe("extractSpecifiers", ...)` block below.
const transpiler = new Bun.Transpiler({ loader: "ts" });

function extractSpecifiers(rawSource: string): string[] {
  return transpiler.scanImports(rawSource).map((entry) => entry.path);
}

// `scanImports` only reports a dynamic `import()`/`require()` call when its
// argument is a literal string or a template literal with no `${...}`
// interpolation (verified below) — a non-literal argument (a bare
// identifier, or an interpolated template literal) is silently omitted from
// its result instead of erroring. The walker can't know what such a call
// might resolve to at runtime, so rather than silently under-reporting the
// graph, this scans the same (comment-stripped, type-erased) transpiled
// source for any `import(`/`require(` call whose argument isn't a static
// string/template literal, and treats a match as a hard failure. Consulting
// the pre-transpiled comment-free/type-erased source (rather than re-running
// our own comment stripper) keeps this check honest about only ever seeing
// what the transpiler itself considers live code.
const dynamicImportOrRequireCall = /\b(?:import|require)\s*\(\s*([\s\S]*?)\)/g;

function isStaticSpecifierArgument(argument: string): boolean {
  const trimmed = argument.trim();
  return (
    /^"(?:[^"\\]|\\.)*"$/.test(trimmed) ||
    /^'(?:[^'\\]|\\.)*'$/.test(trimmed) ||
    /^`[^`$]*`$/.test(trimmed)
  );
}

function findUnresolvableDynamicSpecifiers(rawSource: string): string[] {
  const transformed = transpiler.transformSync(rawSource, "ts");
  const unresolvable: string[] = [];

  for (const match of transformed.matchAll(dynamicImportOrRequireCall)) {
    const argument = match[1];
    if (argument !== undefined && !isStaticSpecifierArgument(argument)) {
      unresolvable.push(argument.trim());
    }
  }

  return unresolvable;
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

    const unresolvable = findUnresolvableDynamicSpecifiers(source);
    if (unresolvable.length > 0) {
      throw new Error(
        `purity walker found a dynamic import()/require() in ${file} whose argument is not a ` +
          `static string/template literal, so Bun's scanImports() cannot resolve it to a ` +
          `specifier: ${unresolvable.join(", ")}. Rewrite it as a static specifier so the walker ` +
          `can verify what it pulls into the bundle.`,
      );
    }

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

  test("extracts a dynamic import() specifier written as a template literal", () => {
    expect(extractSpecifiers("const mod = await import(`./dynamic-target.ts`);")).toEqual([
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

  test("a semicolon-less type alias does not swallow the next, real import", () => {
    const source = `export type Foo = number\nimport { b } from "./bad.ts";`;
    expect(extractSpecifiers(source)).toEqual(["./bad.ts"]);
  });

  test("excludes a bare quoted 'from' string argument, not a real from-clause", () => {
    expect(extractSpecifiers(`missing("vonage", "from")`)).toEqual([]);
  });
});

describe("findUnresolvableDynamicSpecifiers", () => {
  test("does not flag a dynamic import() with a literal string argument", () => {
    expect(findUnresolvableDynamicSpecifiers(`await import("./foo.ts");`)).toEqual([]);
  });

  test("does not flag a dynamic import() with a non-interpolated template literal argument", () => {
    expect(findUnresolvableDynamicSpecifiers("await import(`./foo.ts`);")).toEqual([]);
  });

  test("flags a dynamic import() with a bare identifier argument", () => {
    expect(findUnresolvableDynamicSpecifiers(`const p = "./foo.ts"; await import(p);`)).toEqual([
      "p",
    ]);
  });

  test("flags a dynamic import() with an interpolated template literal argument", () => {
    expect(
      findUnresolvableDynamicSpecifiers("const p = `foo`; await import(`./${p}.ts`);"),
    ).toEqual(["`./${p}.ts`"]);
  });

  test("flags a require() with a bare identifier argument", () => {
    expect(findUnresolvableDynamicSpecifiers(`const p = "./foo.ts"; require(p);`)).toEqual(["p"]);
  });
});

describe("collectImportGraph", () => {
  test("throws a named error when a specifier cannot be resolved on disk", () => {
    const missingFile = join(srcDir, "__does-not-exist__.ts");
    expect(() => collectImportGraph(missingFile)).toThrow(
      `purity walker could not resolve ${missingFile} (imported somewhere in the pure graph)`,
    );
  });

  test("throws when a file contains an unresolvable dynamic import()/require() argument", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supabase-purity-walker-"));
    try {
      const entryFile = join(cwd, "entry.ts");
      writeFileSync(entryFile, `const p = "./foo.ts";\nawait import(p);\n`);

      expect(() => collectImportGraph(entryFile)).toThrow(/cannot resolve it to a specifier/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
  "config-diff.ts",
  "errors.ts",
  "config-document.ts",
  "functions-manifest-model.ts",
  "sparse.ts",
  "schema-metadata.ts",
  "tls.ts",
  "lib/env.ts",
  "lib/schema.ts",
  "lib/secret-paths.ts",
  "project-config/api-attributes.ts",
  "project-config/project-config.ts",
  "project-config/registry-auth.ts",
  "project-config/registry-row.ts",
  "project-config/registry.ts",
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
  "workers.ts",
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
        "AUTH_HOOK_NAMES",
        "CLI_CONFIG_SCHEMA_URL",
        "CliConfigParseError",
        "CliConfigSchema",
        "CliProjectEnvParseError",
        "DuplicateRemoteProjectIdError",
        "ENV_CAPTURE_REGEX",
        "InvalidRemoteProjectIdError",
        "KONG_LOCAL_CA_CERT",
        "MissingCliConfigValueError",
        "ProjectConfigParseError",
        "attachApiResponse",
        "cliConfigValueSourceAt",
        "comparableProjectConfigPaths",
        "diffProjectConfig",
        "edgeFunctionDenoConfigFileName",
        "edgeFunctionEntrypointFileName",
        "edgeFunctionsDirectoryName",
        "encodeCliConfigToJson",
        "encodeCliConfigToToml",
        "fromApiProjectConfig",
        "fromConfigDocument",
        "getDefaultCliConfig",
        "isComparableProjectConfigPath",
        "isEqualConfigValue",
        "omitDefaultValues",
        "projectConfigApiBlockKeys",
        "projectConfigMappingRows",
        "subtractCliConfig",
        "toCliConfigJsonSchema",
        "toProjectConfig",
        "unmappedApiFields",
        "unmappedSecretApiPaths",
      ]
    `);
  });
});

describe("src/effect.ts is a superset of src/index.ts", () => {
  test("pins the exact set of runtime export names", () => {
    expect(Object.keys(effectEntrypoint).sort()).toMatchInlineSnapshot(`
      [
        "AUTH_HOOK_NAMES",
        "CLI_CONFIG_SCHEMA_URL",
        "CliConfigParseError",
        "CliConfigSchema",
        "CliConfigStore",
        "CliProjectEnvParseError",
        "DuplicateRemoteProjectIdError",
        "ENV_CAPTURE_REGEX",
        "InvalidRemoteProjectIdError",
        "KONG_LOCAL_CA_CERT",
        "MissingCliConfigValueError",
        "ProjectConfigParseError",
        "attachApiResponse",
        "cliConfigStoreLayer",
        "cliConfigValueSourceAt",
        "comparableProjectConfigPaths",
        "configJsonPath",
        "configTomlPath",
        "diffProjectConfig",
        "edgeFunctionDenoConfigFileName",
        "edgeFunctionEntrypointFileName",
        "edgeFunctionsDirectoryName",
        "encodeCliConfigToJson",
        "encodeCliConfigToToml",
        "findCliProjectPaths",
        "findCliProjectRoot",
        "fromApiProjectConfig",
        "fromConfigDocument",
        "getDefaultCliConfig",
        "inferFunctionsManifest",
        "isComparableProjectConfigPath",
        "isEqualConfigValue",
        "loadCliConfig",
        "loadCliConfigFile",
        "loadCliProjectEnvironment",
        "loadDotEnvFile",
        "omitDefaultValues",
        "projectConfigApiBlockKeys",
        "projectConfigMappingRows",
        "resolveCliConfigSubtree",
        "resolveCliConfigValue",
        "saveCliConfig",
        "subtractCliConfig",
        "toCliConfigJsonSchema",
        "toProjectConfig",
        "unmappedApiFields",
        "unmappedSecretApiPaths",
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

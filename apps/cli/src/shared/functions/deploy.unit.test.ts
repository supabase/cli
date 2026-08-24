import { tmpdir } from "node:os";

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { Effect, FileSystem, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as EffectPath from "effect/Path";

import {
  buildDockerBinds as buildDockerBindsEffect,
  dockerBindHostPath,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
import { FunctionImportNotDirectoryError } from "./deploy.errors.ts";

const { join } = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));
const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const withFileSystem = <A>(
  effect: Effect.Effect<A, PlatformError, FileSystem.FileSystem>,
): Effect.Effect<A, PlatformError, never> => effect.pipe(Effect.provide(BunFileSystem.layer));

const makeDirectory = (path: string, recursive = false) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path, { recursive });
    }),
  );
const makeTempDirectory = (prefix: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix });
    }),
  );
const realPath = (path: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.realPath(path);
    }),
  );
const remove = (path: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true, force: true });
    }),
  );
const writeFileString = (path: string, contents: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path, contents);
    }),
  );
const symlink = (target: string, path: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.symlink(target, path);
    }),
  );

type PromiseBuildOptions = Omit<
  NonNullable<Parameters<typeof buildDockerBindsEffect>[4]>,
  "onWarning"
> & {
  readonly onWarning?: (message: string) => Effect.Effect<void>;
};

function buildDockerBinds(
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options?: PromiseBuildOptions,
) {
  const onWarning = options?.onWarning;
  return buildDockerBindsEffect(
    projectId,
    functionsDir,
    outputDir,
    config,
    options === undefined
      ? undefined
      : {
          ...options,
          onWarning: onWarning === undefined ? undefined : (message) => onWarning(message),
        },
  ).pipe(Effect.provide(BunFileSystem.layer));
}

const warningCollector =
  (warnings: Array<string>) =>
  (message: string): Effect.Effect<void> =>
    Effect.sync(() => warnings.push(message));

/**
 * `../../` from `<root>/supabase/functions/hello/deno.json`'s directory
 * lands at `<root>/supabase/_vendor/package/dist/index.mjs` — deliberately
 * OUTSIDE `functionsDir` (`<root>/supabase/functions`) so a bind for it
 * survives `sanitizeDockerBinds`, which strips every bind under
 * `functionsDir`/`outputDir`. That makes bind-list assertions observable
 * instead of vacuously true.
 */
const VENDOR_TARGET_RELATIVE = "../../_vendor/package/dist/index.mjs";
/** Import-maps spec: a value for a "/"-suffixed key should itself end in "/". */
const VENDOR_TARGET_RELATIVE_SLASH = "../../_vendor/package/dist/index.mjs/";

function createFunctionProjectWithDenoJson(
  denoJson: Readonly<Record<string, unknown>>,
  indexTsContents: string,
) {
  // realpath the temp dir up front: on macOS `TMPDIR` resolves through a
  // `/var` -> `/private/var` symlink, and `buildDockerBinds` compares
  // realpath'd module roots against a non-realpath'd fallback path for a
  // dotted-but-nonexistent specifier — an unresolved symlink prefix would
  // make every path below "outside the source root" and mask the real
  // assertions this file is testing.
  return Effect.gen(function* () {
    const root = yield* realPath(yield* makeTempDirectory("deploy-import-scanner-"));
    const functionsDir = join(root, "supabase", "functions");
    const functionDir = join(functionsDir, "hello");
    const outputDir = join(root, "out");

    yield* makeDirectory(functionDir, true);
    yield* makeDirectory(outputDir, true);

    const entrypoint = join(functionDir, "index.ts");
    const importMap = join(functionDir, "deno.json");
    yield* writeFileString(entrypoint, indexTsContents);
    yield* writeFileString(importMap, encodeJsonText(denoJson));

    const config: ResolvedDeployFunctionConfig = {
      slug: "hello",
      enabled: true,
      entrypoint,
      importMap,
      staticFiles: [],
      env: {},
    };

    return { root, functionsDir, functionDir, outputDir, config };
  });
}

function createHelloFunctionProject(
  denoJsonImports: Record<string, string>,
  indexTsContents: string,
) {
  return createFunctionProjectWithDenoJson({ imports: denoJsonImports }, indexTsContents);
}

function writeVendorIndexFile(root: string) {
  return Effect.gen(function* () {
    const vendorDir = join(root, "supabase", "_vendor", "package", "dist");
    yield* makeDirectory(vendorDir, true);
    const vendorIndexPath = join(vendorDir, "index.mjs");
    yield* writeFileString(vendorIndexPath, "export const core = 1;\n");
    return vendorIndexPath;
  });
}

function createVendoredFunctionProject(indexTsContents: string) {
  return Effect.gen(function* () {
    const project = yield* createHelloFunctionProject(
      { "@supabase/server": VENDOR_TARGET_RELATIVE },
      indexTsContents,
    );
    const vendorIndexPath = yield* writeVendorIndexFile(project.root);
    return { ...project, vendorIndexPath };
  });
}

function createSlashVendoredFunctionProject(indexTsContents: string) {
  return Effect.gen(function* () {
    const project = yield* createHelloFunctionProject(
      { "@supabase/server/": VENDOR_TARGET_RELATIVE_SLASH },
      indexTsContents,
    );
    const vendorIndexPath = yield* writeVendorIndexFile(project.root);
    return { ...project, vendorIndexPath };
  });
}

describe("buildDockerBinds — import-map key matching (spec-strict) and the file-mapped-key guard", () => {
  it("does not descend into a symlinked static glob directory", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          {},
          'Deno.serve(() => new Response("ok"));\n',
        );
        const assetsDir = join(root, "assets");
        const outsideDir = join(root, "outside-assets");
        const linkedDir = join(assetsDir, "linked");
        yield* makeDirectory(join(outsideDir, "nested"), true);
        yield* writeFileString(join(outsideDir, "nested", "secret.txt"), "secret\n");
        yield* makeDirectory(assetsDir, true);
        yield* symlink(outsideDir, linkedDir);

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, {
            ...config,
            staticFiles: [join(assetsDir, "**")],
          });

          expect(binds.some((bind) => bind.includes("secret.txt"))).toBe(false);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("includes symlinked static glob files without following symlinked directories", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          {},
          'Deno.serve(() => new Response("ok"));\n',
        );
        const assetsDir = join(root, "assets");
        const outsideFile = join(root, "outside-asset.txt");
        const linkedFile = join(assetsDir, "linked.txt");
        yield* writeFileString(outsideFile, "linked\n");
        yield* makeDirectory(assetsDir, true);
        yield* symlink(outsideFile, linkedFile);

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, {
            ...config,
            staticFiles: [join(assetsDir, "**")],
          });

          expect(binds).toContain(`${outsideFile}:${outsideFile}:ro`);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("drops a specifier reachable only through a JSDoc comment, now via a no-match on the unqualified bare key (not the extension guard)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Import-maps spec: a bare key ("@supabase/server", no trailing slash)
        // matches only exactly, so "@supabase/server/core" no longer substitutes
        // at all here — it is dropped as an unresolvable bare specifier before
        // the final-segment guard ever runs. Kept as its own test because it
        // pins the exact field-reported shape; see the "final-segment guard"
        // test below for the guard itself under a spec-valid `/`-suffixed key.
        const { root, functionsDir, outputDir, config, vendorIndexPath } =
          yield* createVendoredFunctionProject(
            [
              "/**",
              " * @example",
              ' * import { core } from "@supabase/server/core";',
              " */",
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) => Effect.sync(() => warnings.push(message)),
          });

          // The vendor file is still bound via the import-map target walk
          // (independent of whether the entrypoint's own specifier matched).
          expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
          expect(binds.some((bind) => bind.includes("index.mjs/core"))).toBe(false);
          expect(warnings).toEqual([]);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("rejects with a FunctionImportNotDirectoryError carrying a clean 'not a directory' message (not a raw ENOTDIR) for a real import reaching a dotted final segment through a `/`-suffixed file-mapped key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createSlashVendoredFunctionProject(
          [
            'import { extra } from "@supabase/server/extra.ts";',
            'Deno.serve(() => new Response("ok"));',
            "",
          ].join("\n"),
        );

        try {
          const result = yield* Effect.result(
            buildDockerBinds("test-project", functionsDir, outputDir, config, {
              onWarning: () => Effect.void,
            }),
          );
          const caught = Result.isFailure(result) ? result.failure : undefined;

          expect(caught).toBeInstanceOf(FunctionImportNotDirectoryError);
          expect((caught as FunctionImportNotDirectoryError)._tag).toBe(
            "FunctionImportNotDirectoryError",
          );
          expect((caught as FunctionImportNotDirectoryError).message).toBe(
            "failed to read file: open supabase/_vendor/package/dist/index.mjs/extra.ts: not a directory",
          );
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("no longer prefix-matches a bare (non-`/`-suffixed) key: a longer specifier stays bare and is skipped without a warning", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createVendoredFunctionProject(
          [
            'import { extra } from "@supabase/server/extra.ts";',
            'Deno.serve(() => new Response("ok"));',
            "",
          ].join("\n"),
        );
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) => Effect.sync(() => warnings.push(message)),
          });

          expect(binds.some((bind) => bind.includes("extra.ts"))).toBe(false);
          expect(warnings).toEqual([]);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("still substitutes on an exact match against a bare key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config, vendorIndexPath } =
          yield* createVendoredFunctionProject(
            [
              'import { server } from "@supabase/server";',
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) => Effect.sync(() => warnings.push(message)),
          });

          expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
          expect(warnings).toEqual([]);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("warns ENOENT-style for a genuinely missing relative import, unaffected by the file-mapped-key guard", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createVendoredFunctionProject(
          [
            'import { missing } from "./missing.ts";',
            'Deno.serve(() => new Response("ok"));',
            "",
          ].join("\n"),
        );
        const warnings: Array<string> = [];

        try {
          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          const matches = warnings.filter(
            (warning) =>
              warning.includes("failed to read file: open ") &&
              warning.includes(": no such file or directory"),
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]).toContain("missing.ts");
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("the final-segment guard still covers the original crash shape under a spec-valid `/`-suffixed map: a JSDoc-only mention is dropped silently", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createSlashVendoredFunctionProject(
          [
            "/**",
            " * @example",
            ' * import { core } from "@supabase/server/core";',
            " */",
            'Deno.serve(() => new Response("ok"));',
            "",
          ].join("\n"),
        );
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          expect(binds.some((bind) => bind.includes("index.mjs/core"))).toBe(false);
          expect(warnings.some((warning) => warning.includes("index.mjs/core"))).toBe(false);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("does not crash when an unreferenced `/`-suffixed import-map target resolves through a file, with no options passed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Regression for a bug found while writing the test above:
        // `forEachLocalImportMapTarget` enumerates every import-map VALUE
        // unconditionally (regardless of whether the entrypoint references it),
        // and Bun's `realpath` — unlike Node's — throws ENOTDIR on a
        // trailing-slash path through a file. A spec-valid `/`-suffixed value
        // (which SHOULD end in "/") pointing at a real file used to crash
        // `buildDockerBinds` with a raw ENOTDIR here, with no options passed —
        // exactly how the real `functions deploy` bundling call site invokes it.
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          { "@x/": VENDOR_TARGET_RELATIVE_SLASH },
          'Deno.serve(() => new Response("ok"));\n',
        );
        yield* writeVendorIndexFile(root);

        try {
          yield* buildDockerBinds("test-project", functionsDir, outputDir, config);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("skips an unreferenced import-map target that resolves through a file, regardless of skipMissingImportMapTargets", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // ENOTDIR (a target routed through a file) is now always skippable, with
        // its own wording distinct from the ENOENT "missing" case below — see
        // "skips a genuinely missing import-map target" for the option's actual
        // gate.
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          { "@x": `${VENDOR_TARGET_RELATIVE}/sub.ts` },
          'Deno.serve(() => new Response("ok"));\n',
        );
        yield* writeVendorIndexFile(root);
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          expect(binds.some((bind) => bind.includes("index.mjs"))).toBe(false);
          expect(
            warnings.some((warning) =>
              warning.includes("Skipping import map target that is not a directory"),
            ),
          ).toBe(true);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("skips a genuinely missing import-map target only when skipMissingImportMapTargets is set", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          { "@missing": "../../does-not-exist.ts" },
          'Deno.serve(() => new Response("ok"));\n',
        );

        try {
          const firstResult = yield* Effect.result(
            buildDockerBinds("test-project", functionsDir, outputDir, config),
          );
          const threwWithoutOption = Result.isFailure(firstResult);
          expect(threwWithoutOption).toBe(true);

          const warnings: Array<string> = [];
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
            skipMissingImportMapTargets: true,
          });

          expect(binds.some((bind) => bind.includes("does-not-exist"))).toBe(false);
          expect(
            warnings.some((warning) => warning.includes("Skipping missing import map target")),
          ).toBe(true);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("drops a `/`-suffixed key whose value lacks a trailing slash (spec-invalid mapping), instead of fabricating a concatenated path", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          { "pkg/": VENDOR_TARGET_RELATIVE },
          [
            'import { core } from "pkg/core.ts";',
            'import { core2 } from "pkg//core.ts";',
            'Deno.serve(() => new Response("ok"));',
            "",
          ].join("\n"),
        );
        yield* writeVendorIndexFile(root);
        const warnings: Array<string> = [];

        try {
          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          // Pre-fix, "pkg/core.ts" fabricated "<vendor>/index.mjscore.ts" (no
          // separator) and "pkg//core.ts" fabricated "<vendor>/index.mjs/core.ts"
          // (a genuine through-a-file crash shape) — both warned or threw.
          expect(warnings).toEqual([]);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("ignores an empty-string import-map key (spec) without crashing; other mappings still resolve", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, functionDir, outputDir, config } =
          yield* createHelloFunctionProject(
            { "": "./x.ts", "@supabase/server": VENDOR_TARGET_RELATIVE },
            [
              'import { server } from "@supabase/server";',
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );
        yield* writeFileString(join(functionDir, "x.ts"), "export const x = 1;\n");
        const vendorIndexPath = yield* writeVendorIndexFile(root);
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
          expect(warnings).toEqual([]);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("resolves via the longest matching `/`-suffixed key when two keys compete", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          {
            "@v/": "../../../dirA/",
            "@v/deep/": "../../../dirB/",
          },
          [
            'import { mod } from "@v/deep/mod.ts";',
            'Deno.serve(() => new Response("ok"));',
            "",
          ].join("\n"),
        );
        yield* makeDirectory(join(root, "dirA"), true);
        yield* makeDirectory(join(root, "dirB"), true);
        const modPath = join(root, "dirB", "mod.ts");
        yield* writeFileString(modPath, "export const mod = 2;\n");
        const warnings: Array<string> = [];

        try {
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          // Proves the LONGER key ("@v/deep/") won: the walker followed
          // "@v/deep/mod.ts" through dirB and bound the resolved FILE. Had the
          // shorter key incorrectly won, the walker would have tried
          // "<dirA>/deep/mod.ts" instead (which does not exist).
          expect(binds.some((bind) => dockerBindHostPath(bind) === modPath)).toBe(true);
          expect(binds.some((bind) => bind.includes(join("dirA", "deep")))).toBe(false);
          expect(warnings).toEqual([]);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("no longer applies a scope whose name coincidentally shares a string prefix with the current file's directory (spec-strict scope matching)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, outputDir, config } = yield* createFunctionProjectWithDenoJson(
          {
            imports: { "@lib": "../../../scoped-test/fallback-lib.ts" },
            scopes: {
              "../hell": { "@lib": "../../../scoped-test/definitely-not-real.ts" },
            },
          },
          ['import { lib } from "@lib";', 'Deno.serve(() => new Response("ok"));', ""].join("\n"),
        );
        yield* makeDirectory(join(root, "scoped-test"), true);
        yield* writeFileString(
          join(root, "scoped-test", "fallback-lib.ts"),
          "export const lib = 1;\n",
        );
        const warnings: Array<string> = [];

        try {
          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
            skipMissingImportMapTargets: true,
          });

          // Scope name "../hell" resolves to ".../functions/hell" — the OLD bare
          // `startsWith` rule let that match the entrypoint's OWN directory
          // (".../functions/hello") purely as a string prefix ("hello" starts
          // with "hell" as characters, not as a path segment). If that scope
          // incorrectly applied, "@lib" would resolve to the scoped (nonexistent)
          // target and the walker itself would emit a "failed to read file"
          // warning for it — distinct from the constant "Skipping missing import
          // map target" warning that the independent, unconditional
          // target-enumeration walk always emits for that same value regardless
          // of whether its scope matches anything.
          expect(
            warnings.some(
              (warning) => warning.includes("failed to read file") && warning.includes("not-real"),
            ),
          ).toBe(false);
          expect(
            warnings.some(
              (warning) =>
                warning.includes("Skipping missing import map target") &&
                warning.includes("not-real"),
            ),
          ).toBe(true);
        } finally {
          yield* remove(root);
        }
      }),
    ));

  it("silently drops a trailing-slash directory-shaped specifier instead of crashing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root, functionsDir, functionDir, outputDir, config } =
          yield* createHelloFunctionProject(
            { "@dir/": "./sub/" },
            'import "@dir/nested/";\nDeno.serve(() => new Response("ok"));\n',
          );
        yield* makeDirectory(join(functionDir, "sub"), true);
        const warnings: Array<string> = [];

        try {
          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: warningCollector(warnings),
          });

          expect(warnings.some((warning) => warning.includes("nested"))).toBe(false);
        } finally {
          yield* remove(root);
        }
      }),
    ));
});

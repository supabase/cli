import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Path, Predicate, Schema } from "effect";

import {
  buildDockerBinds,
  discoverFunctionSlugs,
  formatDockerBind,
  pruneRedundantDockerBinds,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
import { FunctionImportNotDirectoryError } from "./deploy.errors.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * `../../` from `<root>/supabase/functions/hello/deno.json`'s directory lands at
 * `<root>/supabase/_vendor/package/dist/index.mjs`, outside `functionsDir`
 * (`<root>/supabase/functions`), so a bind for it survives `sanitizeDockerBinds`, which strips
 * every bind under `functionsDir`/`outputDir`. That makes bind-list assertions observable
 * instead of vacuously true.
 */
const VENDOR_TARGET_RELATIVE = "../../_vendor/package/dist/index.mjs";
/** Import-maps spec: a value for a "/"-suffixed key should itself end in "/". */
const VENDOR_TARGET_RELATIVE_SLASH = "../../_vendor/package/dist/index.mjs/";

const createFunctionProjectWithDenoJson = Effect.fnUntraced(function* (
  denoJson: Readonly<Record<string, unknown>>,
  indexTsContents: string,
  options: { readonly nestedProject?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // realpath the temp dir up front: on macOS `TMPDIR` resolves through a `/var` ->
  // `/private/var` symlink, and `buildDockerBinds` compares realpath'd module roots against a
  // non-realpath'd fallback path — an unresolved prefix would make every path look "outside the
  // source root" and mask the real assertions here.
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "deploy-import-scanner-" }),
  );
  const projectRoot = options.nestedProject ? path.join(root, "infra", "my-project") : root;
  const functionsDir = path.join(projectRoot, "supabase", "functions");
  const functionDir = path.join(functionsDir, "hello");
  const outputDir = path.join(projectRoot, "out");

  yield* fs.makeDirectory(functionDir, { recursive: true });
  yield* fs.makeDirectory(outputDir, { recursive: true });
  if (options.nestedProject) {
    yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(projectRoot, ".git"), "gitdir: ignored\n");
  }

  const entrypoint = path.join(functionDir, "index.ts");
  const importMap = path.join(functionDir, "deno.json");
  yield* fs.writeFileString(entrypoint, indexTsContents);
  yield* fs.writeFileString(importMap, yield* encodeJson(denoJson));

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

const createHelloFunctionProject = (
  denoJsonImports: Record<string, string>,
  indexTsContents: string,
) => createFunctionProjectWithDenoJson({ imports: denoJsonImports }, indexTsContents);

const writeVendorIndexFile = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vendorDir = path.join(root, "supabase", "_vendor", "package", "dist");
  yield* fs.makeDirectory(vendorDir, { recursive: true });
  const vendorIndexPath = path.join(vendorDir, "index.mjs");
  yield* fs.writeFileString(vendorIndexPath, "export const core = 1;\n");
  return vendorIndexPath;
});

const createVendoredFunctionProject = Effect.fnUntraced(function* (indexTsContents: string) {
  const project = yield* createHelloFunctionProject(
    { "@supabase/server": VENDOR_TARGET_RELATIVE },
    indexTsContents,
  );
  const vendorIndexPath = yield* writeVendorIndexFile(project.root);
  return { ...project, vendorIndexPath };
});

const createSlashVendoredFunctionProject = Effect.fnUntraced(function* (indexTsContents: string) {
  const project = yield* createHelloFunctionProject(
    { "@supabase/server/": VENDOR_TARGET_RELATIVE_SLASH },
    indexTsContents,
  );
  const vendorIndexPath = yield* writeVendorIndexFile(project.root);
  return { ...project, vendorIndexPath };
});

layer(BunServices.layer)(
  "buildDockerBinds — import-map key matching (spec-strict) and the file-mapped-key guard",
  (it) => {
    it.effect(
      "drops a specifier reachable only through a JSDoc comment, now via a no-match on the unqualified bare key (not the extension guard)",
      () =>
        Effect.gen(function* () {
          // A bare key ("@supabase/server", no trailing slash) matches only exactly, so
          // "@supabase/server/core" is dropped as an unresolvable bare specifier before the
          // final-segment guard ever runs — see "final-segment guard" below for the guard itself.
          const { functionsDir, outputDir, config, vendorIndexPath } =
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

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(binds.some((bind) => bind.hostPath === vendorIndexPath)).toBe(true);
          expect(binds.some((bind) => formatDockerBind(bind).includes("index.mjs/core"))).toBe(
            false,
          );
          expect(warnings).toEqual([]);
        }),
    );

    it.effect(
      "rejects with a FunctionImportNotDirectoryError carrying a clean 'not a directory' message (not a raw ENOTDIR) for a real import reaching a dotted final segment through a `/`-suffixed file-mapped key",
      () =>
        Effect.gen(function* () {
          const { functionsDir, outputDir, config } = yield* createSlashVendoredFunctionProject(
            [
              'import { extra } from "@supabase/server/extra.ts";',
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );

          const exit = yield* Effect.exit(
            buildDockerBinds("test-project", functionsDir, outputDir, config, {
              onWarning: () => Effect.void,
            }),
          );
          const caught = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
          expect(caught).toBeInstanceOf(FunctionImportNotDirectoryError);
          expect(Predicate.isTagged(caught, "FunctionImportNotDirectoryError")).toBe(true);
          expect(caught).toMatchObject({
            message:
              "failed to read file: open supabase/_vendor/package/dist/index.mjs/extra.ts: not a directory",
          });
        }),
    );

    it.effect(
      "no longer prefix-matches a bare (non-`/`-suffixed) key: a longer specifier stays bare and is skipped without a warning",
      () =>
        Effect.gen(function* () {
          const { functionsDir, outputDir, config } = yield* createVendoredFunctionProject(
            [
              'import { extra } from "@supabase/server/extra.ts";',
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );
          const warnings: Array<string> = [];

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(binds.some((bind) => formatDockerBind(bind).includes("extra.ts"))).toBe(false);
          expect(warnings).toEqual([]);
        }),
    );

    it.effect("still substitutes on an exact match against a bare key", () =>
      Effect.gen(function* () {
        const { functionsDir, outputDir, config, vendorIndexPath } =
          yield* createVendoredFunctionProject(
            [
              'import { server } from "@supabase/server";',
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );
        const warnings: Array<string> = [];

        const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
          onWarning: (message) =>
            Effect.sync(() => {
              warnings.push(message);
            }),
        });

        expect(binds.some((bind) => bind.hostPath === vendorIndexPath)).toBe(true);
        expect(warnings).toEqual([]);
      }),
    );

    it.effect(
      "warns ENOENT-style for a genuinely missing relative import, unaffected by the file-mapped-key guard",
      () =>
        Effect.gen(function* () {
          const { functionsDir, outputDir, config } = yield* createVendoredFunctionProject(
            [
              'import { missing } from "./missing.ts";',
              'Deno.serve(() => new Response("ok"));',
              "",
            ].join("\n"),
          );
          const warnings: Array<string> = [];

          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          const matches = warnings.filter(
            (warning) =>
              warning.includes("failed to read file: open ") &&
              warning.includes(": no such file or directory"),
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]).toContain("missing.ts");
        }),
    );

    it.effect(
      "the final-segment guard still covers the original crash shape under a spec-valid `/`-suffixed map: a JSDoc-only mention is dropped silently",
      () =>
        Effect.gen(function* () {
          const { functionsDir, outputDir, config } = yield* createSlashVendoredFunctionProject(
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

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(binds.some((bind) => formatDockerBind(bind).includes("index.mjs/core"))).toBe(
            false,
          );
          expect(warnings.some((warning) => warning.includes("index.mjs/core"))).toBe(false);
        }),
    );

    it.effect(
      "does not crash when an unreferenced `/`-suffixed import-map target resolves through a file, with no options passed",
      () =>
        Effect.gen(function* () {
          // `forEachLocalImportMapTarget` enumerates every import-map value unconditionally, and
          // Bun's `realpath` (unlike Node's) throws ENOTDIR on a trailing-slash path through a file —
          // this reproduces that with no options passed, matching how the real bundling call site
          // invokes it.
          const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
            { "@x/": VENDOR_TARGET_RELATIVE_SLASH },
            'Deno.serve(() => new Response("ok"));\n',
          );
          yield* writeVendorIndexFile(root);

          yield* buildDockerBinds("test-project", functionsDir, outputDir, config);
        }),
    );

    it.effect(
      "skips an unreferenced import-map target that resolves through a file, regardless of skipMissingImportMapTargets",
      () =>
        Effect.gen(function* () {
          // ENOTDIR (a target routed through a file) is always skippable, with its own wording
          // distinct from the ENOENT "missing" case below — see "skips a genuinely missing import-map
          // target" for that option's actual gate.
          const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
            { "@x": `${VENDOR_TARGET_RELATIVE}/sub.ts` },
            'Deno.serve(() => new Response("ok"));\n',
          );
          yield* writeVendorIndexFile(root);
          const warnings: Array<string> = [];

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(binds.some((bind) => formatDockerBind(bind).includes("index.mjs"))).toBe(false);
          expect(
            warnings.some((warning) =>
              warning.includes("Skipping import map target that is not a directory"),
            ),
          ).toBe(true);
        }),
    );

    it.effect(
      "skips a genuinely missing import-map target only when skipMissingImportMapTargets is set",
      () =>
        Effect.gen(function* () {
          const { functionsDir, outputDir, config } = yield* createHelloFunctionProject(
            { "@missing": "../../does-not-exist.ts" },
            'Deno.serve(() => new Response("ok"));\n',
          );

          const withoutOption = yield* Effect.exit(
            buildDockerBinds("test-project", functionsDir, outputDir, config),
          );
          expect(Exit.isFailure(withoutOption)).toBe(true);
          expect(Exit.isFailure(withoutOption) && Cause.hasDies(withoutOption.cause)).toBe(true);
          expect(
            Exit.isFailure(withoutOption) ? Cause.squash(withoutOption.cause) : undefined,
          ).toMatchObject({ code: "ENOENT" });

          const warnings: Array<string> = [];
          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
            skipMissingImportMapTargets: true,
          });

          expect(binds.some((bind) => formatDockerBind(bind).includes("does-not-exist"))).toBe(
            false,
          );
          expect(
            warnings.some((warning) => warning.includes("Skipping missing import map target")),
          ).toBe(true);
        }),
    );

    it.effect("skips a missing scope target when missing import targets are skipped", () =>
      Effect.gen(function* () {
        const { functionsDir, outputDir, config } = yield* createFunctionProjectWithDenoJson(
          {
            scopes: {
              __local: { __missing: "../../does-not-exist" },
            },
          },
          'Deno.serve(() => new Response("ok"));\n',
        );
        const warnings: Array<string> = [];

        const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
          onWarning: (message) =>
            Effect.sync(() => {
              warnings.push(message);
            }),
          skipMissingImportMapTargets: true,
        });

        expect(binds.some((bind) => formatDockerBind(bind).includes("does-not-exist"))).toBe(false);
        expect(
          warnings.some((warning) => warning.includes("Skipping missing import map target")),
        ).toBe(true);
      }),
    );

    it.effect("keeps scanning imports from file-valued scope targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, functionsDir, outputDir, config } = yield* createFunctionProjectWithDenoJson(
          {
            scopes: {
              __local: { __scope: "../../_scope/entry.ts" },
            },
          },
          'Deno.serve(() => new Response("ok"));\n',
        );
        const scopeDir = path.join(root, "supabase", "_scope");
        const scopeEntrypoint = path.join(scopeDir, "entry.ts");
        const scopeDependency = path.join(scopeDir, "dependency.ts");
        yield* fs.makeDirectory(scopeDir, { recursive: true });
        yield* fs.writeFileString(
          scopeEntrypoint,
          'export { dependency } from "./dependency.ts";\n',
        );
        yield* fs.writeFileString(scopeDependency, 'export const dependency = "scope";\n');

        const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config);
        const hostPaths = binds.map((bind) => bind.hostPath);

        expect(hostPaths).toContain(scopeEntrypoint);
        expect(hostPaths).toContain(scopeDependency);
      }),
    );

    it.effect(
      "mounts an out-of-root file-valued scope target itself, warns, and does not follow its imports",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { root, functionsDir, outputDir, config } =
            yield* createFunctionProjectWithDenoJson(
              {
                scopes: { __local: { __mod: "../../../../../libs/thing/mod.ts" } },
              },
              'Deno.serve(() => new Response("ok"));\n',
              { nestedProject: true },
            );
          const libsDir = path.join(root, "libs", "thing");
          const scopeEntrypoint = path.join(libsDir, "mod.ts");
          const scopeDependency = path.join(libsDir, "util.ts");
          const warnings: Array<string> = [];

          yield* fs.makeDirectory(libsDir, { recursive: true });
          yield* fs.writeFileString(scopeEntrypoint, 'export { util } from "./util.ts";\n');
          yield* fs.writeFileString(scopeDependency, 'export const util = "thing";\n');

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });
          const hostPaths = binds.map((bind) => bind.hostPath);

          expect(hostPaths).toContain(scopeEntrypoint);
          expect(hostPaths).not.toContain(scopeDependency);
          expect(binds.filter((bind) => bind.externalScope).map((bind) => bind.hostPath)).toEqual([
            scopeEntrypoint,
          ]);
          expect(warnings).toContainEqual(
            `WARN: Mounting import map scope target outside the project root: ${scopeEntrypoint}\n`,
          );
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "does not duplicate the functions mount when its directory is symlinked",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { functionsDir, outputDir, config } = yield* createFunctionProjectWithDenoJson(
            {
              scopes: {
                __local: { __functions: ".." },
              },
            },
            'Deno.serve(() => new Response("ok"));\n',
          );
          const externalRoot = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "deploy-external-functions-" }),
          );
          const externalFunctionsDir = path.join(externalRoot, "functions");
          yield* fs.rename(functionsDir, externalFunctionsDir);
          yield* fs.symlink(externalFunctionsDir, functionsDir);

          const warnings: Array<string> = [];

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });
          const functionsBinds = binds.filter(
            (bind) => bind.containerPath === path.resolve(functionsDir),
          );

          expect(functionsBinds).toHaveLength(1);
          expect(functionsBinds[0]?.hostPath).toBe(path.resolve(functionsDir));
          expect(binds.filter((bind) => bind.externalScope)).toHaveLength(0);
          expect(
            warnings.filter((warning) => warning.includes("Mounting import map scope target")),
          ).toHaveLength(0);
        }),
    );

    it.effect(
      "drops a `/`-suffixed key whose value lacks a trailing slash (spec-invalid mapping), instead of fabricating a concatenated path",
      () =>
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

          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(warnings).toEqual([]);
        }),
    );

    it.effect(
      "ignores an empty-string import-map key (spec) without crashing; other mappings still resolve",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { root, functionsDir, functionDir, outputDir, config } =
            yield* createHelloFunctionProject(
              { "": "./x.ts", "@supabase/server": VENDOR_TARGET_RELATIVE },
              [
                'import { server } from "@supabase/server";',
                'Deno.serve(() => new Response("ok"));',
                "",
              ].join("\n"),
            );
          yield* fs.writeFileString(path.join(functionDir, "x.ts"), "export const x = 1;\n");
          const vendorIndexPath = yield* writeVendorIndexFile(root);
          const warnings: Array<string> = [];

          const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(binds.some((bind) => bind.hostPath === vendorIndexPath)).toBe(true);
          expect(warnings).toEqual([]);
        }),
    );

    it.effect("resolves via the longest matching `/`-suffixed key when two keys compete", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
        yield* fs.makeDirectory(path.join(root, "dirA"), { recursive: true });
        yield* fs.makeDirectory(path.join(root, "dirB"), { recursive: true });
        const modPath = path.join(root, "dirB", "mod.ts");
        yield* fs.writeFileString(modPath, "export const mod = 2;\n");
        const warnings: Array<string> = [];

        const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
          onWarning: (message) =>
            Effect.sync(() => {
              warnings.push(message);
            }),
        });

        expect(binds.some((bind) => bind.hostPath === modPath)).toBe(true);
        expect(
          binds.some((bind) => formatDockerBind(bind).includes(path.join("dirA", "deep"))),
        ).toBe(false);
        expect(warnings).toEqual([]);
      }),
    );

    it.effect(
      "no longer applies a scope whose name coincidentally shares a string prefix with the current file's directory (spec-strict scope matching)",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { root, functionsDir, outputDir, config } =
            yield* createFunctionProjectWithDenoJson(
              {
                imports: { "@lib": "../../../scoped-test/fallback-lib.ts" },
                scopes: {
                  "../hell": { "@lib": "../../../scoped-test/definitely-not-real.ts" },
                },
              },
              ['import { lib } from "@lib";', 'Deno.serve(() => new Response("ok"));', ""].join(
                "\n",
              ),
            );
          yield* fs.makeDirectory(path.join(root, "scoped-test"), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, "scoped-test", "fallback-lib.ts"),
            "export const lib = 1;\n",
          );
          const warnings: Array<string> = [];

          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
            skipMissingImportMapTargets: true,
          });

          // If the scope incorrectly matched, "@lib" would emit a "failed to read file" warning
          // instead of the constant "Skipping missing import map target" warning every target
          // enumeration walk emits regardless of scope matching.
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
        }),
    );

    it.effect(
      "silently drops a trailing-slash directory-shaped specifier instead of crashing",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { functionsDir, functionDir, outputDir, config } =
            yield* createHelloFunctionProject(
              { "@dir/": "./sub/" },
              'import "@dir/nested/";\nDeno.serve(() => new Response("ok"));\n',
            );
          yield* fs.makeDirectory(path.join(functionDir, "sub"), { recursive: true });
          const warnings: Array<string> = [];

          yield* buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }),
          });

          expect(warnings.some((warning) => warning.includes("nested"))).toBe(false);
        }),
    );

    it.effect("skips an invalid static_files glob instead of failing, binding nothing for it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          {},
          'Deno.serve(() => new Response("ok"));\n',
        );
        const assetsDir = path.join(root, "supabase", "assets");
        yield* fs.makeDirectory(assetsDir, { recursive: true });
        yield* fs.writeFileString(path.join(assetsDir, "[z-a].txt"), "a\n");

        const baseline = yield* buildDockerBinds("test-project", functionsDir, outputDir, config);
        const binds = yield* buildDockerBinds("test-project", functionsDir, outputDir, {
          ...config,
          staticFiles: [path.join(assetsDir, "[z-a].txt")],
        });

        expect(binds).toEqual(baseline);
      }),
    );

    it.effect("keeps walking imports after the caller is interrupted", () =>
      Effect.gen(function* () {
        const { functionsDir, outputDir, config } = yield* createHelloFunctionProject(
          {},
          ['import "../../../outside-a.ts";', 'import "../../../outside-b.ts";', ""].join("\n"),
        );
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const continued = yield* Deferred.make<void>();
        const warnings: Array<string> = [];

        const caller = yield* Effect.forkChild(
          buildDockerBinds("test-project", functionsDir, outputDir, config, {
            onWarning: (message) =>
              Effect.sync(() => {
                warnings.push(message);
              }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.flatMap((first) =>
                  first ? Deferred.await(gate) : Deferred.succeed(continued, undefined),
                ),
                Effect.asVoid,
              ),
          }),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(continued);

        expect(warnings).toEqual(
          expect.arrayContaining([
            "WARN: failed to read file: open outside-a.ts: no such file or directory\n",
            "WARN: failed to read file: open outside-b.ts: no such file or directory\n",
          ]),
        );
      }),
    );
  },
);

layer(BunServices.layer)("discoverFunctionSlugs — function directories on disk", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "includes symlinked function directories and skips files, links to files, broken links and entrypoint-less directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "deploy-discover-slugs-" }),
        );
        const functionsDir = path.join(projectRoot, "supabase", "functions");
        const externalDir = path.join(projectRoot, "elsewhere", "linked");
        yield* fs.makeDirectory(path.join(functionsDir, "realdir"), { recursive: true });
        yield* fs.writeFileString(path.join(functionsDir, "realdir", "index.ts"), "export {};\n");
        yield* fs.makeDirectory(externalDir, { recursive: true });
        yield* fs.writeFileString(path.join(externalDir, "index.ts"), "export {};\n");
        yield* fs.symlink(externalDir, path.join(functionsDir, "linked"));
        yield* fs.symlink(
          path.join(functionsDir, "realdir", "index.ts"),
          path.join(functionsDir, "filelink"),
        );
        yield* fs.symlink(path.join(projectRoot, "nowhere"), path.join(functionsDir, "broken"));
        yield* fs.makeDirectory(path.join(functionsDir, "noentry"), { recursive: true });
        yield* fs.writeFileString(path.join(functionsDir, "noentry", "other.ts"), "export {};\n");
        yield* fs.writeFileString(path.join(functionsDir, "plainfile"), "x\n");

        expect(yield* discoverFunctionSlugs(projectRoot, {})).toEqual(["linked", "realdir"]);
      }),
  );
});

describe("pruneRedundantDockerBinds — child binds covered by a parent bind", () => {
  const bind = (hostPath: string, containerPath: string, mode: "ro" | "rw" = "ro") => ({
    hostPath,
    containerPath,
    mode,
    externalScope: false,
  });

  it("drops a file bind nested inside a same-mode directory bind at the same container offset", () => {
    const parent = bind("/repo/packages/orm", "/repo/packages/orm");
    const child = bind("/repo/packages/orm/core/foo.ts", "/repo/packages/orm/core/foo.ts");
    expect(pruneRedundantDockerBinds([parent, child])).toEqual([parent]);
  });

  it("collapses a whole covered subtree while keeping every parent, regardless of order", () => {
    const ormDir = bind("/repo/packages/orm", "/repo/packages/orm");
    const schemasDir = bind("/repo/packages/schemas", "/repo/packages/schemas");
    const children = [
      bind("/repo/packages/orm/index.ts", "/repo/packages/orm/index.ts"),
      bind("/repo/packages/orm/core/foo.ts", "/repo/packages/orm/core/foo.ts"),
      bind("/repo/packages/schemas/kinds/blah.ts", "/repo/packages/schemas/kinds/blah.ts"),
    ];
    expect(
      pruneRedundantDockerBinds([children[0]!, ormDir, children[1]!, schemasDir, children[2]!]),
    ).toEqual([ormDir, schemasDir]);
  });

  it("prunes through chains: a file covered by a directory that is itself covered", () => {
    const outer = bind("/repo/packages", "/repo/packages");
    const inner = bind("/repo/packages/orm", "/repo/packages/orm");
    const leaf = bind("/repo/packages/orm/index.ts", "/repo/packages/orm/index.ts");
    expect(pruneRedundantDockerBinds([outer, inner, leaf])).toEqual([outer]);
  });

  it("keeps a child whose mode differs from the covering parent", () => {
    const parent = bind("/repo/packages/orm", "/repo/packages/orm", "ro");
    const child = bind("/repo/packages/orm/data", "/repo/packages/orm/data", "rw");
    expect(pruneRedundantDockerBinds([parent, child])).toEqual([parent, child]);
  });

  it("keeps a child mapped to a different container offset than the parent supplies", () => {
    const parent = bind("/repo/packages/orm", "/repo/packages/orm");
    const overridden = bind("/repo/packages/orm/index.ts", "/elsewhere/index.ts");
    expect(pruneRedundantDockerBinds([parent, overridden])).toEqual([parent, overridden]);
  });

  it("never treats sibling paths sharing a name prefix as nested", () => {
    const a = bind("/repo/packages/orm", "/repo/packages/orm");
    const sibling = bind("/repo/packages/orm-extras/x.ts", "/repo/packages/orm-extras/x.ts");
    expect(pruneRedundantDockerBinds([a, sibling])).toEqual([a, sibling]);
  });

  it("leaves named-volume binds and unrelated host binds untouched", () => {
    const volume = bind("supabase_edge_runtime_x", "/root/.cache/deno", "rw");
    const output = bind("/repo/out", "/repo/out", "rw");
    expect(pruneRedundantDockerBinds([volume, output])).toEqual([volume, output]);
  });

  it("never collapses two identical binds into one", () => {
    const first = bind("/repo/packages/orm", "/repo/packages/orm");
    const second = bind("/repo/packages/orm", "/repo/packages/orm");
    expect(pruneRedundantDockerBinds([first, second])).toEqual([first, second]);
  });

  it("normalizes Windows-style separators when matching ancestry", () => {
    const parent = bind("C:\\repo\\packages\\orm", "/repo/packages/orm");
    const child = bind("C:\\repo\\packages\\orm\\index.ts", "/repo/packages/orm/index.ts");
    expect(pruneRedundantDockerBinds([parent, child])).toEqual([parent]);
  });

  it("lets a filesystem-root bind cover descendants without covering itself", () => {
    const root = bind("/", "/");
    const child = bind("/repo/packages/orm", "/repo/packages/orm");
    expect(pruneRedundantDockerBinds([root, child])).toEqual([root]);
    expect(pruneRedundantDockerBinds([root, root])).toEqual([root, root]);
  });

  it("lets a drive-root bind cover descendants", () => {
    const root = bind("C:\\", "/");
    const child = bind("C:\\repo\\orm", "/repo/orm");
    expect(pruneRedundantDockerBinds([root, child])).toEqual([root]);
  });

  it("keeps a child a root bind does not supply at that container path", () => {
    const root = bind("/", "/");
    const overridden = bind("/repo/orm/index.ts", "/elsewhere/index.ts");
    expect(pruneRedundantDockerBinds([root, overridden])).toEqual([root, overridden]);
  });
});

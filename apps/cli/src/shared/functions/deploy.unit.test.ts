import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDockerBinds,
  formatDockerBind,
  pruneRedundantDockerBinds,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
import { FunctionImportNotDirectoryError } from "./deploy.errors.ts";

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

async function createFunctionProjectWithDenoJson(
  denoJson: Readonly<Record<string, unknown>>,
  indexTsContents: string,
  options: { readonly nestedProject?: boolean } = {},
) {
  // realpath the temp dir up front: on macOS `TMPDIR` resolves through a `/var` ->
  // `/private/var` symlink, and `buildDockerBinds` compares realpath'd module roots against a
  // non-realpath'd fallback path — an unresolved prefix would make every path look "outside the
  // source root" and mask the real assertions here.
  const root = await realpath(await mkdtemp(join(tmpdir(), "deploy-import-scanner-")));
  const projectRoot = options.nestedProject ? join(root, "infra", "my-project") : root;
  const functionsDir = join(projectRoot, "supabase", "functions");
  const functionDir = join(functionsDir, "hello");
  const outputDir = join(projectRoot, "out");

  await mkdir(functionDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  if (options.nestedProject) {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(projectRoot, ".git"), "gitdir: ignored\n");
  }

  const entrypoint = join(functionDir, "index.ts");
  const importMap = join(functionDir, "deno.json");
  await writeFile(entrypoint, indexTsContents);
  await writeFile(importMap, JSON.stringify(denoJson));

  const config: ResolvedDeployFunctionConfig = {
    slug: "hello",
    enabled: true,
    entrypoint,
    importMap,
    staticFiles: [],
    env: {},
  };

  return { root, functionsDir, functionDir, outputDir, config };
}

async function createHelloFunctionProject(
  denoJsonImports: Record<string, string>,
  indexTsContents: string,
) {
  return createFunctionProjectWithDenoJson({ imports: denoJsonImports }, indexTsContents);
}

async function writeVendorIndexFile(root: string) {
  const vendorDir = join(root, "supabase", "_vendor", "package", "dist");
  await mkdir(vendorDir, { recursive: true });
  const vendorIndexPath = join(vendorDir, "index.mjs");
  await writeFile(vendorIndexPath, "export const core = 1;\n");
  return vendorIndexPath;
}

async function createVendoredFunctionProject(indexTsContents: string) {
  const project = await createHelloFunctionProject(
    { "@supabase/server": VENDOR_TARGET_RELATIVE },
    indexTsContents,
  );
  const vendorIndexPath = await writeVendorIndexFile(project.root);
  return { ...project, vendorIndexPath };
}

async function createSlashVendoredFunctionProject(indexTsContents: string) {
  const project = await createHelloFunctionProject(
    { "@supabase/server/": VENDOR_TARGET_RELATIVE_SLASH },
    indexTsContents,
  );
  const vendorIndexPath = await writeVendorIndexFile(project.root);
  return { ...project, vendorIndexPath };
}

describe("buildDockerBinds — import-map key matching (spec-strict) and the file-mapped-key guard", () => {
  it("drops a specifier reachable only through a JSDoc comment, now via a no-match on the unqualified bare key (not the extension guard)", async () => {
    // A bare key ("@supabase/server", no trailing slash) matches only exactly, so
    // "@supabase/server/core" is dropped as an unresolvable bare specifier before the
    // final-segment guard ever runs — see "final-segment guard" below for the guard itself.
    const { root, functionsDir, outputDir, config, vendorIndexPath } =
      await createVendoredFunctionProject(
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
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => bind.hostPath === vendorIndexPath)).toBe(true);
      expect(binds.some((bind) => formatDockerBind(bind).includes("index.mjs/core"))).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects with a FunctionImportNotDirectoryError carrying a clean 'not a directory' message (not a raw ENOTDIR) for a real import reaching a dotted final segment through a `/`-suffixed file-mapped key", async () => {
    const { root, functionsDir, outputDir, config } = await createSlashVendoredFunctionProject(
      [
        'import { extra } from "@supabase/server/extra.ts";',
        'Deno.serve(() => new Response("ok"));',
        "",
      ].join("\n"),
    );

    try {
      let caught: unknown;
      try {
        await buildDockerBinds("test-project", functionsDir, outputDir, config, {
          onWarning: async () => {},
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(FunctionImportNotDirectoryError);
      expect((caught as FunctionImportNotDirectoryError)._tag).toBe(
        "FunctionImportNotDirectoryError",
      );
      expect((caught as FunctionImportNotDirectoryError).message).toBe(
        "failed to read file: open supabase/_vendor/package/dist/index.mjs/extra.ts: not a directory",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no longer prefix-matches a bare (non-`/`-suffixed) key: a longer specifier stays bare and is skipped without a warning", async () => {
    const { root, functionsDir, outputDir, config } = await createVendoredFunctionProject(
      [
        'import { extra } from "@supabase/server/extra.ts";',
        'Deno.serve(() => new Response("ok"));',
        "",
      ].join("\n"),
    );
    const warnings: Array<string> = [];

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => formatDockerBind(bind).includes("extra.ts"))).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still substitutes on an exact match against a bare key", async () => {
    const { root, functionsDir, outputDir, config, vendorIndexPath } =
      await createVendoredFunctionProject(
        [
          'import { server } from "@supabase/server";',
          'Deno.serve(() => new Response("ok"));',
          "",
        ].join("\n"),
      );
    const warnings: Array<string> = [];

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => bind.hostPath === vendorIndexPath)).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns ENOENT-style for a genuinely missing relative import, unaffected by the file-mapped-key guard", async () => {
    const { root, functionsDir, outputDir, config } = await createVendoredFunctionProject(
      ['import { missing } from "./missing.ts";', 'Deno.serve(() => new Response("ok"));', ""].join(
        "\n",
      ),
    );
    const warnings: Array<string> = [];

    try {
      await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      const matches = warnings.filter(
        (warning) =>
          warning.includes("failed to read file: open ") &&
          warning.includes(": no such file or directory"),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toContain("missing.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the final-segment guard still covers the original crash shape under a spec-valid `/`-suffixed map: a JSDoc-only mention is dropped silently", async () => {
    const { root, functionsDir, outputDir, config } = await createSlashVendoredFunctionProject(
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
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => formatDockerBind(bind).includes("index.mjs/core"))).toBe(false);
      expect(warnings.some((warning) => warning.includes("index.mjs/core"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not crash when an unreferenced `/`-suffixed import-map target resolves through a file, with no options passed", async () => {
    // `forEachLocalImportMapTarget` enumerates every import-map value unconditionally, and
    // Bun's `realpath` (unlike Node's) throws ENOTDIR on a trailing-slash path through a file —
    // this reproduces that with no options passed, matching how the real bundling call site
    // invokes it.
    const { root, functionsDir, outputDir, config } = await createHelloFunctionProject(
      { "@x/": VENDOR_TARGET_RELATIVE_SLASH },
      'Deno.serve(() => new Response("ok"));\n',
    );
    await writeVendorIndexFile(root);

    try {
      await buildDockerBinds("test-project", functionsDir, outputDir, config);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an unreferenced import-map target that resolves through a file, regardless of skipMissingImportMapTargets", async () => {
    // ENOTDIR (a target routed through a file) is always skippable, with its own wording
    // distinct from the ENOENT "missing" case below — see "skips a genuinely missing import-map
    // target" for that option's actual gate.
    const { root, functionsDir, outputDir, config } = await createHelloFunctionProject(
      { "@x": `${VENDOR_TARGET_RELATIVE}/sub.ts` },
      'Deno.serve(() => new Response("ok"));\n',
    );
    await writeVendorIndexFile(root);
    const warnings: Array<string> = [];

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => formatDockerBind(bind).includes("index.mjs"))).toBe(false);
      expect(
        warnings.some((warning) =>
          warning.includes("Skipping import map target that is not a directory"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a genuinely missing import-map target only when skipMissingImportMapTargets is set", async () => {
    const { root, functionsDir, outputDir, config } = await createHelloFunctionProject(
      { "@missing": "../../does-not-exist.ts" },
      'Deno.serve(() => new Response("ok"));\n',
    );

    try {
      let threwWithoutOption = false;
      try {
        await buildDockerBinds("test-project", functionsDir, outputDir, config);
      } catch {
        threwWithoutOption = true;
      }
      expect(threwWithoutOption).toBe(true);

      const warnings: Array<string> = [];
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
        skipMissingImportMapTargets: true,
      });

      expect(binds.some((bind) => formatDockerBind(bind).includes("does-not-exist"))).toBe(false);
      expect(
        warnings.some((warning) => warning.includes("Skipping missing import map target")),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a missing scope target when missing import targets are skipped", async () => {
    const { root, functionsDir, outputDir, config } = await createFunctionProjectWithDenoJson(
      {
        scopes: {
          __local: { __missing: "../../does-not-exist" },
        },
      },
      'Deno.serve(() => new Response("ok"));\n',
    );
    const warnings: Array<string> = [];

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
        skipMissingImportMapTargets: true,
      });

      expect(binds.some((bind) => formatDockerBind(bind).includes("does-not-exist"))).toBe(false);
      expect(
        warnings.some((warning) => warning.includes("Skipping missing import map target")),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps scanning imports from file-valued scope targets", async () => {
    const { root, functionsDir, outputDir, config } = await createFunctionProjectWithDenoJson(
      {
        scopes: {
          __local: { __scope: "../../_scope/entry.ts" },
        },
      },
      'Deno.serve(() => new Response("ok"));\n',
    );
    const scopeDir = join(root, "supabase", "_scope");
    const scopeEntrypoint = join(scopeDir, "entry.ts");
    const scopeDependency = join(scopeDir, "dependency.ts");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(scopeEntrypoint, 'export { dependency } from "./dependency.ts";\n');
    await writeFile(scopeDependency, 'export const dependency = "scope";\n');

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config);
      const hostPaths = binds.map((bind) => bind.hostPath);

      expect(hostPaths).toContain(scopeEntrypoint);
      expect(hostPaths).toContain(scopeDependency);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mounts an out-of-root file-valued scope target itself, warns, and does not follow its imports", async () => {
    const { root, functionsDir, outputDir, config } = await createFunctionProjectWithDenoJson(
      {
        scopes: { __local: { __mod: "../../../../../libs/thing/mod.ts" } },
      },
      'Deno.serve(() => new Response("ok"));\n',
      { nestedProject: true },
    );
    const libsDir = join(root, "libs", "thing");
    const scopeEntrypoint = join(libsDir, "mod.ts");
    const scopeDependency = join(libsDir, "util.ts");
    const warnings: Array<string> = [];

    try {
      await mkdir(libsDir, { recursive: true });
      await writeFile(scopeEntrypoint, 'export { util } from "./util.ts";\n');
      await writeFile(scopeDependency, 'export const util = "thing";\n');

      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not duplicate the functions mount when its directory is symlinked",
    async () => {
      const { root, functionsDir, outputDir, config } = await createFunctionProjectWithDenoJson(
        {
          scopes: {
            __local: { __functions: ".." },
          },
        },
        'Deno.serve(() => new Response("ok"));\n',
      );
      const externalRoot = await realpath(
        await mkdtemp(join(tmpdir(), "deploy-external-functions-")),
      );
      const externalFunctionsDir = join(externalRoot, "functions");
      await rename(functionsDir, externalFunctionsDir);
      await symlink(externalFunctionsDir, functionsDir, "dir");

      const warnings: Array<string> = [];

      try {
        const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
          onWarning: async (message) => {
            warnings.push(message);
          },
        });
        const functionsBinds = binds.filter((bind) => bind.containerPath === resolve(functionsDir));

        expect(functionsBinds).toHaveLength(1);
        expect(functionsBinds[0]?.hostPath).toBe(resolve(functionsDir));
        expect(binds.filter((bind) => bind.externalScope)).toHaveLength(0);
        expect(
          warnings.filter((warning) => warning.includes("Mounting import map scope target")),
        ).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it("drops a `/`-suffixed key whose value lacks a trailing slash (spec-invalid mapping), instead of fabricating a concatenated path", async () => {
    const { root, functionsDir, outputDir, config } = await createHelloFunctionProject(
      { "pkg/": VENDOR_TARGET_RELATIVE },
      [
        'import { core } from "pkg/core.ts";',
        'import { core2 } from "pkg//core.ts";',
        'Deno.serve(() => new Response("ok"));',
        "",
      ].join("\n"),
    );
    await writeVendorIndexFile(root);
    const warnings: Array<string> = [];

    try {
      await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores an empty-string import-map key (spec) without crashing; other mappings still resolve", async () => {
    const { root, functionsDir, functionDir, outputDir, config } = await createHelloFunctionProject(
      { "": "./x.ts", "@supabase/server": VENDOR_TARGET_RELATIVE },
      [
        'import { server } from "@supabase/server";',
        'Deno.serve(() => new Response("ok"));',
        "",
      ].join("\n"),
    );
    await writeFile(join(functionDir, "x.ts"), "export const x = 1;\n");
    const vendorIndexPath = await writeVendorIndexFile(root);
    const warnings: Array<string> = [];

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => bind.hostPath === vendorIndexPath)).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves via the longest matching `/`-suffixed key when two keys compete", async () => {
    const { root, functionsDir, outputDir, config } = await createHelloFunctionProject(
      {
        "@v/": "../../../dirA/",
        "@v/deep/": "../../../dirB/",
      },
      ['import { mod } from "@v/deep/mod.ts";', 'Deno.serve(() => new Response("ok"));', ""].join(
        "\n",
      ),
    );
    await mkdir(join(root, "dirA"), { recursive: true });
    await mkdir(join(root, "dirB"), { recursive: true });
    const modPath = join(root, "dirB", "mod.ts");
    await writeFile(modPath, "export const mod = 2;\n");
    const warnings: Array<string> = [];

    try {
      const binds = await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(binds.some((bind) => bind.hostPath === modPath)).toBe(true);
      expect(binds.some((bind) => formatDockerBind(bind).includes(join("dirA", "deep")))).toBe(
        false,
      );
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no longer applies a scope whose name coincidentally shares a string prefix with the current file's directory (spec-strict scope matching)", async () => {
    const { root, functionsDir, outputDir, config } = await createFunctionProjectWithDenoJson(
      {
        imports: { "@lib": "../../../scoped-test/fallback-lib.ts" },
        scopes: {
          "../hell": { "@lib": "../../../scoped-test/definitely-not-real.ts" },
        },
      },
      ['import { lib } from "@lib";', 'Deno.serve(() => new Response("ok"));', ""].join("\n"),
    );
    await mkdir(join(root, "scoped-test"), { recursive: true });
    await writeFile(join(root, "scoped-test", "fallback-lib.ts"), "export const lib = 1;\n");
    const warnings: Array<string> = [];

    try {
      await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
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
            warning.includes("Skipping missing import map target") && warning.includes("not-real"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("silently drops a trailing-slash directory-shaped specifier instead of crashing", async () => {
    const { root, functionsDir, functionDir, outputDir, config } = await createHelloFunctionProject(
      { "@dir/": "./sub/" },
      'import "@dir/nested/";\nDeno.serve(() => new Response("ok"));\n',
    );
    await mkdir(join(functionDir, "sub"), { recursive: true });
    const warnings: Array<string> = [];

    try {
      await buildDockerBinds("test-project", functionsDir, outputDir, config, {
        onWarning: async (message) => {
          warnings.push(message);
        },
      });

      expect(warnings.some((warning) => warning.includes("nested"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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

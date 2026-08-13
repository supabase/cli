import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDockerBinds,
  dockerBindHostPath,
  type ResolvedDeployFunctionConfig,
} from "./deploy.ts";
import { FunctionImportNotDirectoryError } from "./deploy.errors.ts";

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

async function createFunctionProjectWithDenoJson(
  denoJson: Readonly<Record<string, unknown>>,
  indexTsContents: string,
) {
  // realpath the temp dir up front: on macOS `TMPDIR` resolves through a
  // `/var` -> `/private/var` symlink, and `buildDockerBinds` compares
  // realpath'd module roots against a non-realpath'd fallback path for a
  // dotted-but-nonexistent specifier — an unresolved symlink prefix would
  // make every path below "outside the source root" and mask the real
  // assertions this file is testing.
  const root = await realpath(await mkdtemp(join(tmpdir(), "deploy-import-scanner-")));
  const functionsDir = join(root, "supabase", "functions");
  const functionDir = join(functionsDir, "hello");
  const outputDir = join(root, "out");

  await mkdir(functionDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

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
    // Import-maps spec: a bare key ("@supabase/server", no trailing slash)
    // matches only exactly, so "@supabase/server/core" no longer substitutes
    // at all here — it is dropped as an unresolvable bare specifier before
    // the final-segment guard ever runs. Kept as its own test because it
    // pins the exact field-reported shape; see the "final-segment guard"
    // test below for the guard itself under a spec-valid `/`-suffixed key.
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

      // The vendor file is still bound via the import-map target walk
      // (independent of whether the entrypoint's own specifier matched).
      expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
      expect(binds.some((bind) => bind.includes("index.mjs/core"))).toBe(false);
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

      expect(binds.some((bind) => bind.includes("extra.ts"))).toBe(false);
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

      expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
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

      expect(binds.some((bind) => bind.includes("index.mjs/core"))).toBe(false);
      expect(warnings.some((warning) => warning.includes("index.mjs/core"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not crash when an unreferenced `/`-suffixed import-map target resolves through a file, with no options passed", async () => {
    // Regression for a bug found while writing the test above:
    // `forEachLocalImportMapTarget` enumerates every import-map VALUE
    // unconditionally (regardless of whether the entrypoint references it),
    // and Bun's `realpath` — unlike Node's — throws ENOTDIR on a
    // trailing-slash path through a file. A spec-valid `/`-suffixed value
    // (which SHOULD end in "/") pointing at a real file used to crash
    // `buildDockerBinds` with a raw ENOTDIR here, with no options passed —
    // exactly how the real `functions deploy` bundling call site invokes it.
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
    // ENOTDIR (a target routed through a file) is now always skippable, with
    // its own wording distinct from the ENOENT "missing" case below — see
    // "skips a genuinely missing import-map target" for the option's actual
    // gate.
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

      expect(binds.some((bind) => bind.includes("index.mjs"))).toBe(false);
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

      expect(binds.some((bind) => bind.includes("does-not-exist"))).toBe(false);
      expect(
        warnings.some((warning) => warning.includes("Skipping missing import map target")),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

      // Pre-fix, "pkg/core.ts" fabricated "<vendor>/index.mjscore.ts" (no
      // separator) and "pkg//core.ts" fabricated "<vendor>/index.mjs/core.ts"
      // (a genuine through-a-file crash shape) — both warned or threw.
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

      expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
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

      // Proves the LONGER key ("@v/deep/") won: the walker followed
      // "@v/deep/mod.ts" through dirB and bound the resolved FILE. Had the
      // shorter key incorrectly won, the walker would have tried
      // "<dirA>/deep/mod.ts" instead (which does not exist).
      expect(binds.some((bind) => dockerBindHostPath(bind) === modPath)).toBe(true);
      expect(binds.some((bind) => bind.includes(join("dirA", "deep")))).toBe(false);
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

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

async function createHelloFunctionProject(
  denoJsonImports: Record<string, string>,
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
  await writeFile(importMap, JSON.stringify({ imports: denoJsonImports }));

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

describe("buildDockerBinds — bare import-map key mapped to a file, longer specifier", () => {
  it("drops a specifier reachable only through a JSDoc comment when it resolves through a file to a dotless final segment", async () => {
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

      // Proves the walker still binds the import-map target itself (the real
      // vendor file), not just that the dropped specifier produced no bind.
      expect(binds.some((bind) => dockerBindHostPath(bind) === vendorIndexPath)).toBe(true);
      expect(binds.some((bind) => bind.includes("index.mjs/core"))).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects with a FunctionImportNotDirectoryError carrying a clean 'not a directory' message (not a raw ENOTDIR) for a real import reaching a dotted final segment through a file-mapped key", async () => {
    const { root, functionsDir, outputDir, config } = await createVendoredFunctionProject(
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

  it("skips an unreferenced import-map target that resolves through a file when skipMissingImportMapTargets is set", async () => {
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
        skipMissingImportMapTargets: true,
      });

      expect(binds.some((bind) => bind.includes("index.mjs"))).toBe(false);
      expect(
        warnings.some((warning) => warning.includes("Skipping missing import map target")),
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

import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toCliConfigJsonSchema } from "../src/base.ts";
import { toProjectConfigJsonSchema } from "../src/project-config/project-schema.ts";

const packageRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageRoot, "../..");

async function runCommand(cmd: readonly string[], cwd: string = packageRoot): Promise<void> {
  const child = Bun.spawn([...cmd], { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`\`${cmd.join(" ")}\` failed with exit code ${exitCode}`);
  }
}

async function renderJsonSchema(outputPath: string, json: unknown): Promise<void> {
  const schema = `${JSON.stringify(json, null, 2)}\n`;

  const formatter = Bun.spawn(["bun", "x", "oxfmt", `--stdin-filepath=${outputPath}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await formatter.stdin.write(schema);
  await formatter.stdin.end();

  const [exitCode, formatted, stderr] = await Promise.all([
    formatter.exited,
    new Response(formatter.stdout).text(),
    new Response(formatter.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`oxfmt failed with exit code ${exitCode}: ${stderr.trim()}`);
  }

  await mkdir("./dist", { recursive: true });
  await Bun.write(outputPath, formatted);
}

/**
 * Proves the package.json `sideEffects: false` claim (a deferred CLI-2230
 * review item) against the real compiled `dist/index.js`, rather than merely
 * asserting it. Bundles a probe importing ONLY `CliConfigSchema` for a
 * browser-ish target: `project-schema.ts`'s import-time invariant guard (and
 * the rest of the `./project-config/registry*.ts` graph it pulls in) must be
 * droppable even though it contains real side-effecting statements — that's
 * exactly what `sideEffects: false` authorizes a bundler to do, and exactly
 * what this asserts actually happened.
 */
async function verifyTreeShaking(): Promise<void> {
  const distIndexPath = await realpath(path.join(packageRoot, "dist", "index.js"));
  // `mkdtemp` can return a path through a symlinked prefix (e.g. macOS's
  // `/var` -> `/private/var`) that Bun's bundler resolves to its canonical
  // form internally when computing the probe entry's own directory — compute
  // the relative specifier against that same canonical form, or a
  // `path.relative` mismatch silently produces a specifier with one too many
  // `../` segments.
  const probeDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "supabase-config-tree-shake-")),
  );

  try {
    const probeEntry = path.join(probeDir, "probe.js");
    const relativeSpecifier = path.relative(probeDir, distIndexPath).split(path.sep).join("/");
    const specifier = relativeSpecifier.startsWith(".")
      ? relativeSpecifier
      : `./${relativeSpecifier}`;
    await Bun.write(probeEntry, `export { CliConfigSchema } from "${specifier}";\n`);

    const result = await Bun.build({
      entrypoints: [probeEntry],
      target: "browser",
      minify: false,
    });

    if (!result.success) {
      const messages = result.logs.map((log) => log.message).join("\n");
      throw new Error(`tree-shake probe failed to bundle:\n${messages}`);
    }

    const [output] = result.outputs;
    if (!output) {
      throw new Error("tree-shake probe produced no bundle output");
    }
    const code = await output.text();

    // Only appears in `src/project-config/registry*.ts` (verified by
    // grepping `dist/`) — a real API attribute path segment, never used by
    // `CliConfigSchema`'s own field names (`base.ts`/`api.ts` use `schemas`,
    // not `db_schema`).
    const REGISTRY_ONLY_MARKER = "db_schema";
    // Only appears in `src/api.ts`, reachable through `CliConfigSchema` —
    // proof the probe still bundled real, non-empty content.
    const SCHEMA_MARKER = "Enable the local PostgREST service.";

    if (code.includes(REGISTRY_ONLY_MARKER)) {
      throw new Error(
        `tree-shake probe failed: bundling only { CliConfigSchema } from dist/index.js still pulled in ` +
          `registry-only code (found marker ${JSON.stringify(REGISTRY_ONLY_MARKER)} from ` +
          `project-config/registry.ts). "sideEffects": false is not holding for this package — ` +
          `investigate before trusting the tree-shaking claim.`,
      );
    }
    if (!code.includes(SCHEMA_MARKER)) {
      throw new Error(
        `tree-shake probe failed: expected schema marker ${JSON.stringify(SCHEMA_MARKER)} is missing from ` +
          `the bundle output — the probe isn't actually exercising CliConfigSchema.`,
      );
    }

    console.log(
      `[build] tree-shake probe OK (${code.length} bytes; registry-only marker absent, schema marker present).`,
    );
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

/**
 * Regenerates a declarations-only build (`tsconfig.api-report.json`, no
 * `.d.ts.map`/`.js`) into a scratch dir and mirrors it into the checked-in
 * `api-report/` (CLI-2234 enforcement layer 4). `src/api-report.unit.test.ts`
 * regenerates the same way and diffs against this mirror, so any type-surface
 * change becomes a reviewable `git diff` instead of a silent drift.
 */
async function syncApiReport(): Promise<void> {
  const apiReportDir = path.join(packageRoot, "api-report");
  const scratchDir = await mkdtemp(path.join(tmpdir(), "supabase-config-api-report-"));

  try {
    await runCommand([
      "pnpm",
      "exec",
      "tsc",
      "-p",
      "tsconfig.api-report.json",
      "--outDir",
      scratchDir,
    ]);

    await rm(apiReportDir, { recursive: true, force: true });
    await mkdir(apiReportDir, { recursive: true });

    const glob = new Bun.Glob("**/*.d.ts");
    let count = 0;
    for await (const relativePath of glob.scan({ cwd: scratchDir })) {
      const dest = path.join(apiReportDir, relativePath);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(scratchDir, relativePath), dest);
      count++;
    }

    console.log(`[build] synced ${count} .d.ts files into api-report/`);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * The real CLI-2232 acceptance check: proves every exports-map subpath
 * actually resolves compiled `dist/` output end-to-end for a real Node
 * consumer — not just that `tsc` produced files. Runs from `apps/cli`
 * (the one in-repo workspace that depends on `@supabase/config`) so the
 * top-level bare specifier resolves through pnpm's real `node_modules` link,
 * exactly like an external consumer would.
 */
async function runNodeSmokeTest(): Promise<void> {
  const nodePath = Bun.which("node");
  if (!nodePath) {
    console.error(
      "[build] `node` executable not found on PATH; skipping the Node-consumer smoke test. This " +
        "step exists specifically to catch a broken `exports` map / dist resolution for real Node " +
        "consumers (CLI-2232) — install Node (mise provides it) and re-run `pnpm build` before " +
        "trusting this package's dist output.",
    );
    return;
  }

  const smokeScript = [
    'import assert from "node:assert/strict";',
    'import { createRequire } from "node:module";',
    "",
    'import { CliConfigSchema, ProjectConfigSchema, toProjectConfigJsonSchema, toCliConfigJsonSchema } from "@supabase/config";',
    "assert.ok(CliConfigSchema, \"CliConfigSchema missing from '.'\");",
    "assert.ok(ProjectConfigSchema, \"ProjectConfigSchema missing from '.'\");",
    "assert.ok(toProjectConfigJsonSchema, \"toProjectConfigJsonSchema missing from '.'\");",
    'assert.equal(typeof toCliConfigJsonSchema(), "object", "toCliConfigJsonSchema() did not return an object");',
    "",
    'const effectMod = await import("@supabase/config/effect");',
    "assert.ok(effectMod.loadCliConfig, \"loadCliConfig missing from './effect'\");",
    "",
    'const ioMod = await import("@supabase/config/io");',
    "assert.ok(ioMod.loadCliConfig, \"loadCliConfig missing from './io'\");",
    "assert.ok(ioMod.inferFunctionsManifest, \"inferFunctionsManifest missing from './io'\");",
    "",
    'const internalMod = await import("@supabase/config/internal");',
    "assert.ok(internalMod.projectConfigMappingRows, \"projectConfigMappingRows missing from './internal'\");",
    "",
    "const require = createRequire(import.meta.url);",
    'const schemaJson = require("@supabase/config/schema.json");',
    'const projectSchemaJson = require("@supabase/config/project-schema.json");',
    'assert.equal(typeof schemaJson, "object", "schema.json did not resolve to an object");',
    'assert.equal(typeof projectSchemaJson, "object", "project-schema.json did not resolve to an object");',
    "",
    'console.log("[build] node smoke test: every entrypoint resolved through the node condition");',
  ].join("\n");

  await runCommand(
    [nodePath, "--input-type=module", "-e", smokeScript],
    path.join(repoRoot, "apps/cli"),
  );
}

console.log("[build] compiling TypeScript project (tsconfig.build.json)...");
await runCommand(["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"]);

console.log("[build] rendering JSON Schema artifacts...");
await renderJsonSchema("./dist/schema.json", toCliConfigJsonSchema());
await renderJsonSchema("./dist/project-schema.json", toProjectConfigJsonSchema());

console.log("[build] verifying the sideEffects:false tree-shaking claim...");
await verifyTreeShaking();

console.log("[build] syncing api-report/ from a declarations-only compile...");
await syncApiReport();

console.log("[build] running the Node-consumer smoke test...");
await runNodeSmokeTest();

console.log("[build] done.");

import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliConfigSchema, toCliConfigJsonSchema } from "../src/base.ts";
import {
  ProjectConfigSchema,
  toProjectConfigJsonSchema,
} from "../src/project-config/project-schema.ts";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "../src/schema-metadata.ts";
import { collapseNonFiniteNumberUnions, withSchemaMetadata } from "./json-schema-postprocess.ts";

const packageRoot = path.resolve(import.meta.dir, "..");

async function runCommand(cmd: readonly string[], cwd: string = packageRoot): Promise<void> {
  const child = Bun.spawn([...cmd], { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`\`${cmd.join(" ")}\` failed with exit code ${exitCode}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Descends `root` at each of `path`, requiring an object at every intermediate step, throwing with a precise location otherwise. */
function readStringAt(root: unknown, path: ReadonlyArray<string>): string {
  let current = root;
  for (const [index, key] of path.entries()) {
    if (!isRecord(current)) {
      throw new Error(
        `expected an object while reading ${path.slice(0, index).join(".")} (looking for "${key}"), got ${typeof current}`,
      );
    }
    current = current[key];
  }
  if (typeof current !== "string") {
    throw new Error(`expected a string at ${path.join(".")}, got ${typeof current}`);
  }
  return current;
}

/**
 * Runs a schema's rendered JSON Schema document through
 * {@link collapseNonFiniteNumberUnions} and {@link withSchemaMetadata}, then
 * writes it via {@link renderJsonSchema}. `collapseNonFiniteNumberUnions`
 * returns `unknown` (it's a generic JSON-tree walk with no static shape
 * guarantee); this narrows it back to an object via `isRecord` rather than an
 * `as` cast — both `toCliConfigJsonSchema()`/`toProjectConfigJsonSchema()`
 * always render a top-level object, so a non-object result here would mean
 * the collapse walk itself is broken, worth failing loudly on.
 */
async function renderCollapsedJsonSchema(
  outputPath: string,
  document: unknown,
  rootAst: Parameters<typeof collapseNonFiniteNumberUnions>[1],
  metadata: Parameters<typeof withSchemaMetadata>[1],
): Promise<void> {
  const collapsed = collapseNonFiniteNumberUnions(document, rootAst);
  if (!isRecord(collapsed)) {
    throw new Error(`collapseNonFiniteNumberUnions did not return an object for ${outputPath}`);
  }
  await renderJsonSchema(outputPath, withSchemaMetadata(collapsed, metadata));
}

async function renderJsonSchema(outputPath: string, json: Record<string, unknown>): Promise<void> {
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

  await mkdir(path.dirname(outputPath), { recursive: true });
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
 * what this asserts actually happened. A second, positive-control probe
 * (bundling `projectConfigMappingRows` from `dist/internal.js`) proves the
 * registry-only marker this test looks for is actually detectable by this
 * exact bundling method in the first place, before trusting its absence from
 * the first probe as meaningful.
 */
async function verifyTreeShaking(): Promise<void> {
  const distIndexPath = await realpath(path.join(packageRoot, "dist", "index.js"));
  const distInternalPath = await realpath(path.join(packageRoot, "dist", "internal.js"));
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
    function relativeSpecifierFor(target: string): string {
      const relative = path.relative(probeDir, target).split(path.sep).join("/");
      return relative.startsWith(".") ? relative : `./${relative}`;
    }

    async function bundle(entryName: string, source: string): Promise<string> {
      const probeEntry = path.join(probeDir, entryName);
      await Bun.write(probeEntry, source);
      const result = await Bun.build({
        entrypoints: [probeEntry],
        target: "browser",
        minify: false,
      });
      if (!result.success) {
        const messages = result.logs.map((log) => log.message).join("\n");
        throw new Error(`tree-shake probe failed to bundle ${entryName}:\n${messages}`);
      }
      const [output] = result.outputs;
      if (!output) {
        throw new Error(`tree-shake probe produced no bundle output for ${entryName}`);
      }
      return output.text();
    }

    // Only appears in `src/project-config/registry*.ts` (verified by
    // grepping `dist/`) — a real API attribute path segment, never used by
    // `CliConfigSchema`'s own field names (`base.ts`/`api.ts` use `schemas`,
    // not `db_schema`).
    const REGISTRY_ONLY_MARKER = "db_schema";
    // Derived at runtime from the actual `CliConfigSchema` annotation it
    // names, rather than hardcoded prose that could silently drift from the
    // real description text — `api.enabled`'s `description`, read off the
    // real rendered JSON Schema document (the same source `dist/schema.json`
    // is built from).
    const SCHEMA_MARKER = readStringAt(toCliConfigJsonSchema(), [
      "properties",
      "api",
      "properties",
      "enabled",
      "description",
    ]);

    const positiveControlCode = await bundle(
      "positive-control.js",
      `export { projectConfigMappingRows } from "${relativeSpecifierFor(distInternalPath)}";\n`,
    );
    if (!positiveControlCode.includes(REGISTRY_ONLY_MARKER)) {
      throw new Error(
        `tree-shake probe's positive control failed: bundling { projectConfigMappingRows } from ` +
          `dist/internal.js did not include marker ${JSON.stringify(REGISTRY_ONLY_MARKER)} — this ` +
          `probe methodology can no longer detect the marker it's meant to prove absent below, so its ` +
          `absence from the CliConfigSchema-only probe would be meaningless.`,
      );
    }

    const code = await bundle(
      "probe.js",
      `export { CliConfigSchema } from "${relativeSpecifierFor(distIndexPath)}";\n`,
    );

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
      `[build] tree-shake probe OK (${code.length} bytes; registry-only marker absent, schema marker present, positive control passed).`,
    );
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

const SMOKE_TEST_RUNTIME_DEPS = [
  "effect",
  "@effect/platform-node",
  "@standard-schema/spec",
  "dedent",
  "smol-toml",
] as const;

function buildSmokeTestScript(): string {
  return [
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
    'console.log("[build] pack-and-install smoke test: every entrypoint resolved through a real npm-packed tarball install");',
  ].join("\n");
}

/**
 * The real CLI-2232/CLI-2234 acceptance check: packs the actual publish
 * tarball (`npm pack`, governed by `files`/`.npmignore` — the exact thing
 * `npm publish` would ship) and installs it into a fresh, isolated consumer
 * project, then imports every entrypoint and JSON artifact through a real
 * `node` process. This catches `files`/`exports` drift the previous
 * workspace-link Node smoke test missed entirely (a workspace `pnpm` link
 * resolves straight to this package's own directory, bypassing `files`
 * filtering altogether).
 *
 * Deliberately extracts the tarball directly (`tar`) rather than `npm install
 * <tarball>`: the latter would additionally try to resolve
 * `@supabase/config`'s own dependency tree (`effect`'s own `fast-check`/
 * `msgpackr`, `@effect/platform-node`'s `undici`/`mime`, …) from the npm
 * registry over the network on every build. Every runtime dependency this
 * smoke test actually needs is already resolved locally by pnpm — symlinking
 * those real, already-resolved package directories in below — the same
 * directories `packages/config/node_modules/*` itself points at — mirrors
 * exactly how pnpm links every other workspace in this monorepo (Node
 * resolves each symlink to its real path before walking further ancestor
 * `node_modules` directories, so each linked package's own transitive deps,
 * already resolved alongside it in the pnpm store, are found the same way).
 * This keeps the check hermetic, fast, and network-free.
 */
async function runPackAndInstallSmokeTest(): Promise<void> {
  const npmPath = Bun.which("npm");
  const nodePath = Bun.which("node");
  const tarPath = Bun.which("tar");
  if (npmPath === null || nodePath === null || tarPath === null) {
    const missing = [
      npmPath === null ? "npm" : null,
      nodePath === null ? "node" : null,
      tarPath === null ? "tar" : null,
    ].filter((name) => name !== null);
    throw new Error(
      `the pack-and-install smoke test (CLI-2234) requires ${missing.join(", ")} on PATH — install ` +
        "it (mise provides node/npm; tar ships with every supported OS) before running `pnpm build`.",
    );
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), "supabase-config-pack-smoke-"));
  try {
    const packResult = Bun.spawn([npmPath, "pack", "--json", "--pack-destination", scratchDir], {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "inherit",
    });
    const [packExitCode, packStdout] = await Promise.all([
      packResult.exited,
      new Response(packResult.stdout).text(),
    ]);
    if (packExitCode !== 0) {
      throw new Error(`\`npm pack\` failed with exit code ${packExitCode}`);
    }
    const packEntries = JSON.parse(packStdout) as ReadonlyArray<{ readonly filename: string }>;
    const [packEntry] = packEntries;
    if (packEntry === undefined) {
      throw new Error("`npm pack --json` produced no tarball entries");
    }
    const tarballPath = path.join(scratchDir, packEntry.filename);

    const consumerDir = path.join(scratchDir, "consumer");
    const consumerConfigDir = path.join(consumerDir, "node_modules", "@supabase", "config");
    await mkdir(consumerConfigDir, { recursive: true });
    await runCommand([
      tarPath,
      "-xzf",
      tarballPath,
      "-C",
      consumerConfigDir,
      "--strip-components=1",
    ]);

    await Bun.write(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify(
        { name: "supabase-config-pack-smoke", version: "0.0.0", private: true, type: "module" },
        null,
        2,
      )}\n`,
    );

    const consumerNodeModules = path.join(consumerDir, "node_modules");
    for (const name of SMOKE_TEST_RUNTIME_DEPS) {
      const real = await realpath(path.join(packageRoot, "node_modules", name));
      const dest = path.join(consumerNodeModules, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await symlink(real, dest, "dir");
    }

    await runCommand([nodePath, "--input-type=module", "-e", buildSmokeTestScript()], consumerDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

interface ExportsMap {
  readonly [subpath: string]: ExportsNode;
}
type ExportsNode = string | { readonly [condition: string]: ExportsNode };

function collectDistTargets(node: ExportsNode, into: Set<string>): void {
  if (typeof node === "string") {
    if (node.startsWith("./dist/")) {
      into.add(node);
    }
    return;
  }
  for (const [condition, value] of Object.entries(node)) {
    // `bun` conditions point at `src/*.ts`, which trivially exists at every
    // commit (it's source, not a build output) — nothing to verify here.
    if (condition === "bun") {
      continue;
    }
    collectDistTargets(value, into);
  }
}

/** CLI-2234: every `types`/`default`/JSON-artifact target the exports map declares must exist once the build finishes. */
async function verifyExportsMapTargetsExist(): Promise<void> {
  const packageJson = JSON.parse(await Bun.file(path.join(packageRoot, "package.json")).text()) as {
    readonly exports: ExportsMap;
  };

  const targets = new Set<string>();
  for (const node of Object.values(packageJson.exports)) {
    collectDistTargets(node, targets);
  }

  const missing: string[] = [];
  for (const target of targets) {
    if (!(await Bun.file(path.join(packageRoot, target)).exists())) {
      missing.push(target);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `the following dist targets declared in package.json's exports map are missing after the ` +
        `build: ${missing.join(", ")}`,
    );
  }
  console.log(`[build] verified ${targets.size} exports-map dist targets exist on disk.`);
}

console.log("[build] removing stale dist/ (stale modules from renames must not ship)...");
await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });

console.log("[build] compiling TypeScript project (tsconfig.build.json)...");
await runCommand(["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"]);

console.log("[build] rendering JSON Schema artifacts...");
await renderCollapsedJsonSchema(
  path.join(packageRoot, "dist", "schema.json"),
  toCliConfigJsonSchema(),
  CliConfigSchema.ast,
  {
    id: CLI_CONFIG_SCHEMA_URL,
    title: "Supabase CLI config (CliConfig)",
    description:
      "The Supabase CLI's local project config document (supabase/config.toml or supabase/config.json).",
  },
);
await renderCollapsedJsonSchema(
  path.join(packageRoot, "dist", "project-schema.json"),
  toProjectConfigJsonSchema(),
  ProjectConfigSchema.ast,
  {
    id: PROJECT_CONFIG_SCHEMA_URL,
    title: "Supabase hosted project config (ProjectConfig)",
    description: "The sparse, hosted-project subset of CliConfig that a Supabase project manages.",
  },
);

console.log("[build] verifying every exports-map dist target exists...");
await verifyExportsMapTargetsExist();

console.log("[build] verifying the sideEffects:false tree-shaking claim...");
await verifyTreeShaking();

console.log("[build] running the pack-and-install smoke test...");
await runPackAndInstallSmokeTest();

console.log("[build] done.");

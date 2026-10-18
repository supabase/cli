import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Layer, Path, type PlatformError, Schema } from "effect";
import { CliConfigSchema, toCliConfigJsonSchema } from "../src/base.ts";
import {
  ProjectConfigSchema,
  toProjectConfigJsonSchema,
} from "../src/project-config/project-schema.ts";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "../src/schema-metadata.ts";
import { collapseNonFiniteNumberUnions, withSchemaMetadata } from "./json-schema-postprocess.ts";

const packageRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dir, "..");
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeIndentedJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

class StdinWriteError extends Data.TaggedError("StdinWriteError")<{ readonly cause: unknown }> {}

class BuildInputError extends Data.TaggedError("BuildInputError")<{
  readonly source: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const buildInputError =
  (source: string) =>
  <A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new BuildInputError({ source, message: cause.message, cause })),
    );

/* Dies with the platform's own error object, so a host failure prints as the raw OS error. */
const dieWithPlatformCause = (error: PlatformError.PlatformError) =>
  Effect.die(error.cause ?? error);

/* Like `try`/`finally`: a cleanup failure replaces the body's outcome rather than joining it. */
const withTempDirectory = <A, E, R, E2, R2>(
  acquire: Effect.Effect<string, E, R>,
  use: (dir: string) => Effect.Effect<A, E2, R2>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.acquireUseRelease(
      acquire,
      (dir) => Effect.exit(use(dir)),
      (dir) =>
        fs
          .remove(dir, { recursive: true, force: true })
          .pipe(Effect.catchTag("PlatformError", dieWithPlatformCause)),
    );
  }).pipe(Effect.flatten);

const runCommand = Effect.fnUntraced(function* (cmd: readonly string[], cwd?: string) {
  const child = Bun.spawn([...cmd], {
    cwd: cwd ?? (yield* packageRoot),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = yield* Effect.promise(() => child.exited);
  if (exitCode !== 0) {
    return yield* Effect.die(new Error(`\`${cmd.join(" ")}\` failed with exit code ${exitCode}`));
  }
});

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
 * Runs a schema document through {@link collapseNonFiniteNumberUnions} and
 * {@link withSchemaMetadata}, then writes it via {@link renderJsonSchema}.
 * Narrows the collapse step's `unknown` result with `isRecord` instead of an
 * `as` cast, since a non-object result here would mean the collapse walk
 * itself is broken.
 */
const renderCollapsedJsonSchema = Effect.fnUntraced(function* (
  outputPath: string,
  document: unknown,
  rootAst: Parameters<typeof collapseNonFiniteNumberUnions>[1],
  metadata: Parameters<typeof withSchemaMetadata>[1],
) {
  const collapsed = collapseNonFiniteNumberUnions(document, rootAst);
  if (!isRecord(collapsed)) {
    return yield* Effect.die(
      new Error(`collapseNonFiniteNumberUnions did not return an object for ${outputPath}`),
    );
  }
  yield* renderJsonSchema(outputPath, withSchemaMetadata(collapsed, metadata));
});

const renderJsonSchema = Effect.fnUntraced(function* (
  outputPath: string,
  json: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const schema = `${yield* encodeIndentedJson(json)}\n`;

  const formatter = Bun.spawn(["bun", "x", "oxfmt", `--stdin-filepath=${outputPath}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  yield* Effect.tryPromise({
    try: () => Promise.resolve(formatter.stdin.write(schema)),
    catch: (cause) => new StdinWriteError({ cause }),
  }).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => Promise.resolve(formatter.stdin.end()),
        catch: (cause) => new StdinWriteError({ cause }),
      }),
    ),
    Effect.catchTag("StdinWriteError", ({ cause: error }) =>
      error instanceof Error && "code" in error && error.code === "EPIPE"
        ? Effect.void
        : Effect.die(error),
    ),
  );

  const [exitCode, formatted, stderr] = yield* Effect.promise(() =>
    Promise.all([
      formatter.exited,
      new Response(formatter.stdout).text(),
      new Response(formatter.stderr).text(),
    ]),
  );
  if (exitCode !== 0) {
    return yield* Effect.die(
      new Error(`oxfmt failed with exit code ${exitCode}: ${stderr.trim()}`),
    );
  }

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, formatted);
});

/**
 * Proves `sideEffects: false` against the real compiled `dist/index.js`, not by
 * assertion alone: bundles a probe importing only `CliConfigSchema` for a
 * browser target, since its registry graph has real side effects but must still
 * tree-shake away. A positive-control probe confirms the test's marker is
 * actually detectable by this method before trusting its absence as meaningful.
 */
const verifyTreeShaking = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* packageRoot;
  const distIndexPath = yield* fs.realPath(path.join(root, "dist", "index.js"));
  const distInternalPath = yield* fs.realPath(path.join(root, "dist", "internal.js"));
  // `mkdtemp` can return a path through a symlinked prefix (e.g. macOS's
  // `/var` -> `/private/var`) that Bun's bundler resolves canonically; compute
  // the relative specifier against that same canonical form, or `path.relative`
  // produces a specifier with one too many `../` segments.
  const makeProbeDir = fs
    .makeTempDirectory({ prefix: "supabase-config-tree-shake-" })
    .pipe(Effect.flatMap((dir) => fs.realPath(dir)));

  const probeInDirectory = Effect.fnUntraced(function* (probeDir: string) {
    function relativeSpecifierFor(target: string): string {
      const relative = path.relative(probeDir, target).split(path.sep).join("/");
      return relative.startsWith(".") ? relative : `./${relative}`;
    }

    const bundle = Effect.fnUntraced(function* (entryName: string, source: string) {
      const probeEntry = path.join(probeDir, entryName);
      yield* fs.writeFileString(probeEntry, source);
      const result = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [probeEntry],
          target: "browser",
          minify: false,
        }),
      );
      if (!result.success) {
        const messages = result.logs.map((log) => log.message).join("\n");
        return yield* Effect.die(
          new Error(`tree-shake probe failed to bundle ${entryName}:\n${messages}`),
        );
      }
      const [output] = result.outputs;
      if (!output) {
        return yield* Effect.die(
          new Error(`tree-shake probe produced no bundle output for ${entryName}`),
        );
      }
      return yield* Effect.promise(() => output.text());
    });

    // Only appears in `src/project-config/registry*.ts`; `CliConfigSchema`'s own
    // field names (`base.ts`/`api.ts`) use `schemas`, not `db_schema`.
    const REGISTRY_ONLY_MARKER = "db_schema";
    // Derived at runtime from `CliConfigSchema`'s own `api.enabled` description,
    // read off the real rendered JSON Schema document, rather than hardcoded
    // prose that could drift from it.
    const SCHEMA_MARKER = readStringAt(toCliConfigJsonSchema(), [
      "properties",
      "api",
      "properties",
      "enabled",
      "description",
    ]);

    const positiveControlCode = yield* bundle(
      "positive-control.js",
      `export { projectConfigMappingRows } from "${relativeSpecifierFor(distInternalPath)}";\n`,
    );
    if (!positiveControlCode.includes(REGISTRY_ONLY_MARKER)) {
      return yield* Effect.die(
        new Error(
          `tree-shake probe's positive control failed: bundling { projectConfigMappingRows } from ` +
            `dist/internal.js did not include marker ${yield* encodeJson(REGISTRY_ONLY_MARKER)} — this ` +
            `probe methodology can no longer detect the marker it's meant to prove absent below, so its ` +
            `absence from the CliConfigSchema-only probe would be meaningless.`,
        ),
      );
    }

    const code = yield* bundle(
      "probe.js",
      `export { CliConfigSchema } from "${relativeSpecifierFor(distIndexPath)}";\n`,
    );

    if (code.includes(REGISTRY_ONLY_MARKER)) {
      return yield* Effect.die(
        new Error(
          `tree-shake probe failed: bundling only { CliConfigSchema } from dist/index.js still pulled in ` +
            `registry-only code (found marker ${yield* encodeJson(REGISTRY_ONLY_MARKER)} from ` +
            `project-config/registry.ts). "sideEffects": false is not holding for this package — ` +
            `investigate before trusting the tree-shaking claim.`,
        ),
      );
    }
    if (!code.includes(SCHEMA_MARKER)) {
      return yield* Effect.die(
        new Error(
          `tree-shake probe failed: expected schema marker ${yield* encodeJson(SCHEMA_MARKER)} is missing from ` +
            `the bundle output — the probe isn't actually exercising CliConfigSchema.`,
        ),
      );
    }

    yield* Console.log(
      `[build] tree-shake probe OK (${code.length} bytes; registry-only marker absent, schema marker present, positive control passed).`,
    );
  });

  yield* withTempDirectory(makeProbeDir, probeInDirectory);
});

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
 * Packs the actual publish tarball (`npm pack`, respecting `files`/`.npmignore`)
 * and installs it into a fresh consumer project, then imports every entrypoint
 * through real `node` — catching drift a workspace `pnpm` link would miss.
 * Extracts with `tar` (not `npm install <tarball>`) and symlinks pnpm's
 * already-resolved deps in, keeping the check hermetic and network-free.
 */
const runPackAndInstallSmokeTest = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* packageRoot;
  const npmPath = Bun.which("npm");
  const nodePath = Bun.which("node");
  const tarPath = Bun.which("tar");
  if (npmPath === null || nodePath === null || tarPath === null) {
    const missing = [
      npmPath === null ? "npm" : null,
      nodePath === null ? "node" : null,
      tarPath === null ? "tar" : null,
    ].filter((name) => name !== null);
    return yield* Effect.die(
      new Error(
        `the pack-and-install smoke test (CLI-2234) requires ${missing.join(", ")} on PATH — install ` +
          "it (mise provides node/npm; tar ships with every supported OS) before running `pnpm build`.",
      ),
    );
  }

  const packAndInstall = Effect.fnUntraced(function* (scratchDir: string) {
    const packResult = Bun.spawn([npmPath, "pack", "--json", "--pack-destination", scratchDir], {
      cwd: root,
      stdout: "pipe",
      stderr: "inherit",
    });
    const [packExitCode, packStdout] = yield* Effect.promise(() =>
      Promise.all([packResult.exited, new Response(packResult.stdout).text()]),
    );
    if (packExitCode !== 0) {
      return yield* Effect.die(new Error(`\`npm pack\` failed with exit code ${packExitCode}`));
    }
    const packEntries = yield* decodePackEntries(packStdout).pipe(
      buildInputError("`npm pack --json` output"),
    );
    const [packEntry] = packEntries;
    if (packEntry === undefined) {
      return yield* Effect.die(new Error("`npm pack --json` produced no tarball entries"));
    }
    const tarballPath = path.join(scratchDir, packEntry.filename);

    const consumerDir = path.join(scratchDir, "consumer");
    const consumerConfigDir = path.join(consumerDir, "node_modules", "@supabase", "config");
    yield* fs.makeDirectory(consumerConfigDir, { recursive: true });
    yield* runCommand([
      tarPath,
      "-xzf",
      tarballPath,
      "-C",
      consumerConfigDir,
      "--strip-components=1",
    ]);

    yield* fs.writeFileString(
      path.join(consumerDir, "package.json"),
      `${yield* encodeIndentedJson({
        name: "supabase-config-pack-smoke",
        version: "0.0.0",
        private: true,
        type: "module",
      })}\n`,
    );

    const consumerNodeModules = path.join(consumerDir, "node_modules");
    for (const name of SMOKE_TEST_RUNTIME_DEPS) {
      const real = yield* fs.realPath(path.join(root, "node_modules", name));
      const dest = path.join(consumerNodeModules, name);
      yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
      yield* fs.symlink(real, dest);
    }

    yield* runCommand([nodePath, "--input-type=module", "-e", buildSmokeTestScript()], consumerDir);
  });

  yield* withTempDirectory(
    fs.makeTempDirectory({ prefix: "supabase-config-pack-smoke-" }),
    packAndInstall,
  );
});

const decodePackageJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodePackEntries = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ filename: Schema.String }))),
);

const collectDistTargets: (
  node: unknown,
  into: Set<string>,
) => Effect.Effect<void, BuildInputError> = Effect.fnUntraced(function* (node, into) {
  if (typeof node === "string") {
    if (node.startsWith("./dist/")) {
      into.add(node);
    }
    return;
  }
  if (node === null || node === undefined) {
    return yield* new BuildInputError({
      source: "package.json",
      message: `an exports target is ${node}`,
    });
  }
  if (!isRecord(node)) {
    return;
  }
  for (const [condition, value] of Object.entries(node)) {
    // `bun` conditions point at `src/*.ts`, which trivially exists at every
    // commit (it's source, not a build output) — nothing to verify here.
    if (condition === "bun") {
      continue;
    }
    yield* collectDistTargets(value, into);
  }
});

/** Every `types`/`default`/JSON-artifact target the exports map declares must exist once the build finishes. */
const verifyExportsMapTargetsExist = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* packageRoot;
  const packageJson = yield* decodePackageJson(
    yield* fs.readFileString(path.join(root, "package.json")),
  ).pipe(buildInputError("package.json"));
  const exportsField = isRecord(packageJson) ? packageJson.exports : undefined;
  if (exportsField === null || exportsField === undefined) {
    return yield* new BuildInputError({
      source: "package.json",
      message: `"exports" is ${exportsField === null ? "null" : "missing"}`,
    });
  }

  const targets = new Set<string>();
  if (isRecord(exportsField)) {
    for (const node of Object.values(exportsField)) {
      yield* collectDistTargets(node, targets);
    }
  }

  const missing: string[] = [];
  for (const target of targets) {
    /* A directory at a target path does not count as an emitted file. */
    const isFile = yield* fs.stat(path.join(root, target)).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (!isFile) {
      missing.push(target);
    }
  }
  if (missing.length > 0) {
    return yield* Effect.die(
      new Error(
        `the following dist targets declared in package.json's exports map are missing after the ` +
          `build: ${missing.join(", ")}`,
      ),
    );
  }
  yield* Console.log(`[build] verified ${targets.size} exports-map dist targets exist on disk.`);
});

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* packageRoot;

  yield* Console.log("[build] removing stale dist/ (stale modules from renames must not ship)...");
  yield* fs.remove(path.join(root, "dist"), { recursive: true, force: true });

  yield* Console.log("[build] compiling TypeScript project (tsconfig.build.json)...");
  yield* runCommand(["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"]);

  yield* Console.log("[build] rendering JSON Schema artifacts...");
  yield* renderCollapsedJsonSchema(
    path.join(root, "dist", "schema.json"),
    toCliConfigJsonSchema(),
    CliConfigSchema.ast,
    {
      id: CLI_CONFIG_SCHEMA_URL,
      title: "Supabase CLI config (CliConfig)",
      description:
        "The Supabase CLI's local project config document (supabase/config.toml or supabase/config.json).",
    },
  );
  yield* renderCollapsedJsonSchema(
    path.join(root, "dist", "project-schema.json"),
    toProjectConfigJsonSchema(),
    ProjectConfigSchema.ast,
    {
      id: PROJECT_CONFIG_SCHEMA_URL,
      title: "Supabase hosted project config (ProjectConfig)",
      description:
        "The sparse, hosted-project subset of CliConfig that a Supabase project manages.",
    },
  );

  yield* Console.log("[build] verifying every exports-map dist target exists...");
  yield* verifyExportsMapTargetsExist();

  yield* Console.log("[build] verifying the sideEffects:false tree-shaking claim...");
  yield* verifyTreeShaking();

  yield* Console.log("[build] running the pack-and-install smoke test...");
  yield* runPackAndInstallSmokeTest();

  yield* Console.log("[build] done.");
});

await Effect.runPromise(
  build.pipe(
    Effect.catchTags({
      PlatformError: dieWithPlatformCause,
      BuildInputError: ({ source, message, cause }) =>
        Effect.die(new Error(`[build] malformed ${source}: ${message}`, { cause })),
    }),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);

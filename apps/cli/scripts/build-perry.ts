import process from "node:process";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { loadComputeStacks } from "../src/shared/compute/compute-stacks.macro.ts";
import { localBuildDefine } from "./compile-options.ts";

/**
 * Compiles the CLI's TypeScript sources to a native binary with Perry into `dist-perry/supabase`,
 * run via `pnpm build:perry`. Set `PERRY` to the compiler binary and `PERRY_RUNTIME_DIR` to its
 * runtime archives. The sources are staged first, rewriting the Bun-only features Perry rejects:
 * the compute-stacks macro and the extensionless Dockerfile text import.
 */
const outdir = "dist-perry";

const napiPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-x64-gnu",
  "linux-x64-musl",
  "win32-arm64-msvc",
  "win32-x64-msvc",
];

const hostNapiPlatform =
  process.platform === "linux"
    ? `linux-${process.arch}-gnu`
    : process.platform === "win32"
      ? `win32-${process.arch}-msvc`
      : `${process.platform}-${process.arch}`;

// Every platform's addon package is installed, and Perry gates each literal `.node` require on
// an approved owner, so the other platforms alias to the host's.
const nativeAddonPrefixes = ["@napi-rs/keyring-"];

const perryPackageJson = {
  name: "supabase-perry",
  private: true,
  type: "module",
  perry: {
    nativeAddons: nativeAddonPrefixes.map((prefix) => `${prefix}${hostNapiPlatform}`),
    packageAliases: {
      ...Object.fromEntries(
        nativeAddonPrefixes.flatMap((prefix) =>
          napiPlatforms
            .filter((platform) => platform !== hostNapiPlatform)
            .map((platform) => [`${prefix}${platform}`, `${prefix}${hostNapiPlatform}`]),
        ),
      ),
      // Unresolvable, so `oxfmt` stays external as in the Bun builds; `gen types` formats without it.
      oxfmt: "oxfmt-external",
      // The ESM entry imports a named export from a UMD file, which only a bundler resolves.
      "@libpg-query/parser": "@libpg-query/parser/wasm/index.cjs",
    },
  },
};

const stageSources = Effect.fn("BuildPerry.stageSources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const src = path.join(outdir, "src");

  yield* fs.remove(src, { recursive: true, force: true });
  yield* fs.copy("src", src);
  const entries = yield* fs.readDirectory(src, { recursive: true });
  const tests = entries.filter((entry) => entry.endsWith(".test.ts"));
  yield* Effect.forEach(tests, (entry) => fs.remove(path.join(src, entry)), { discard: true });
  yield* Effect.annotateCurrentSpan({ files: entries.length - tests.length });

  const services = path.join(src, "shared", "services");
  yield* fs.rename(path.join(services, "Dockerfile"), path.join(services, "Dockerfile.txt"));
  const dockerfileImages = path.join(services, "dockerfile-images.ts");
  yield* fs.writeFileString(
    dockerfileImages,
    (yield* fs.readFileString(dockerfileImages)).replace('"./Dockerfile"', '"./Dockerfile.txt"'),
  );

  const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const stacks = yield* loadComputeStacks(path.join("src", "shared", "compute", "stacks"));
  yield* fs.writeFileString(
    path.join(src, "shared", "compute", "compute-stacks.ts"),
    `import type { ComputeRuntime } from "./compute-runtimes.ts";
import type { ComputeStack } from "./compute-stacks.macro.ts";

export const COMPUTE_STACKS: Record<ComputeRuntime, ComputeStack> = ${yield* encodeJson(stacks)};
`,
  );

  yield* fs.writeFileString(
    path.join(outdir, "perry.json"),
    yield* encodeJson({ define: yield* localBuildDefine }),
  );
  yield* fs.writeFileString(path.join(outdir, "package.json"), yield* encodeJson(perryPackageJson));
});

const compile = Effect.fn("BuildPerry.compile")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const perry = yield* Config.String("PERRY").pipe(Config.withDefault("perry"));
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(perry, ["compile", "src/main.ts", "--platform", "bun", "-o", "supabase"], {
      cwd: outdir,
      extendEnv: true,
      env: {
        PERRY_NO_TELEMETRY: "1",
        // Shipped TS sources are not the published runtime: they import dev-only packages
        // (`@supabase/tracing`), tsconfig path aliases (posthog-node) and emitted `const enum`s
        // (tldts).
        PERRY_PREFER_EMIT_PACKAGES: "*",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  yield* Effect.annotateCurrentSpan({ exitCode: Number(exitCode) });
  if (Number(exitCode) !== 0) {
    return yield* Effect.die(`perry compile exited ${exitCode}`);
  }
  yield* Console.log(`${outdir}/supabase`);
});

const main = Effect.gen(function* () {
  yield* stageSources();
  yield* compile();
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}

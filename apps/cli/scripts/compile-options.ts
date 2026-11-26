import { BunCrypto, BunServices } from "@effect/platform-bun";
import { stackSourceDigest } from "@supabase/stack/internal/release";
import { Effect, Layer } from "effect";
import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";

/**
 * Shared compile options keep release, local, and E2E builds exercising the shipped binary
 * compilation behavior.
 */
export const compileOptions = {
  minify: true,
  bytecode: true,
  bytecodeDepth: 2,
  format: "esm",
  // `oxfmt` is an optional peer of `@supabase/postgrest-typegen`, loaded only by the default
  // TypeScript formatter; `gen types` supplies its own, so the binary ships without it.
  external: ["oxfmt"],
} as const satisfies Partial<Bun.BuildConfig>;

/**
 * Embeds the stack release of the sources being compiled, so the binary drives exactly the owners
 * started from the same stack sources, whether compiled or run from source.
 */
export const stackReleaseDefine = () =>
  Effect.runPromise(
    stackSourceDigest.pipe(Effect.provide(Layer.merge(BunServices.layer, BunCrypto.layerDigest))),
  ).then((digest) => ({
    SUPABASE_STACK_BUILD_ID: JSON.stringify(digest),
  }));

/**
 * The `define` map shared by local builds: the CLI version, the stack release, the pre-bundled
 * edge-runtime template, and the msgpackr native-addon probe switch.
 */
export const localBuildDefine = () =>
  Promise.all([
    Bun.file(new URL("../package.json", import.meta.url)).json() as Promise<{ version?: string }>,
    stackReleaseDefine(),
    Effect.runPromise(bundleServeMainTemplate()),
  ]).then(([packageJson, release, serveMainTemplate]) => {
    if (packageJson.version === undefined || packageJson.version.length === 0) {
      throw new Error("CLI package version is required for a build");
    }
    return {
      SUPABASE_CLI_VERSION: JSON.stringify(packageJson.version),
      ...release,
      SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: JSON.stringify(serveMainTemplate),
      // Skips msgpackr's native addon probe at the build host's path, which can hang macOS startup.
      "process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED": JSON.stringify("true"),
    };
  });

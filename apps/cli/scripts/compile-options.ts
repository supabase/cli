import { BunServices } from "@effect/platform-bun";
import { stackSourceDigest } from "@supabase/stack/internal/release";
import { Effect, Schema } from "effect";
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
  Effect.runPromise(stackSourceDigest.pipe(Effect.provide(BunServices.layer))).then((digest) => ({
    SUPABASE_STACK_BUILD_ID: JSON.stringify(digest),
  }));

const CliPackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }));

const defineString = (value: string) => JSON.stringify(value);

/** Build-time constants for a local CLI build, whether compiled to a binary or bundled for Node. */
export const localBuildDefine = Effect.gen(function* () {
  const { version } = yield* Schema.decodeEffect(CliPackageJson)(
    yield* Effect.promise(() => Bun.file(new URL("../package.json", import.meta.url)).text()),
  );
  return {
    SUPABASE_CLI_VERSION: defineString(version),
    ...(yield* Effect.promise(() => stackReleaseDefine())),
    SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: defineString(yield* bundleServeMainTemplate()),
    // Skips msgpackr's native addon probe at the build host's path, which can hang macOS startup.
    "process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED": defineString("true"),
  };
});

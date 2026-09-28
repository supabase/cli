import { BunServices } from "@effect/platform-bun";
import { stackSourceDigest } from "@supabase/stack/internal/release";
import { Effect } from "effect";

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
} as const satisfies Partial<Bun.BuildConfig>;;

/**
 * Embeds the stack release of the sources being compiled, so the binary drives exactly the owners
 * started from the same stack sources, whether compiled or run from source.
 */
export const stackReleaseDefine = async () => ({
  SUPABASE_STACK_BUILD_ID: JSON.stringify(
    await Effect.runPromise(stackSourceDigest.pipe(Effect.provide(BunServices.layer))),
  ),
});

import { BunServices } from "@effect/platform-bun";
import { stackSourceDigest } from "@supabase/stack/internal/release";
import { Effect } from "effect";

/**
 * Shared compile options keep release, local, and E2E builds exercising the shipped binary
 * compilation behavior. `bytecodeDepth` is accepted by Bun 1.4.1 but is not yet in bun-types.
 */
export const compileOptions = {
  minify: true,
  bytecode: true,
  bytecodeDepth: 2,
  format: "esm" as const,
};

/**
 * Embeds the stack release of the sources being compiled, so the binary drives exactly the owners
 * started from the same stack sources, whether compiled or run from source.
 */
export const stackReleaseDefine = async () => ({
  SUPABASE_STACK_BUILD_ID: JSON.stringify(
    await Effect.runPromise(stackSourceDigest.pipe(Effect.provide(BunServices.layer))),
  ),
});

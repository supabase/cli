import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Data, Effect } from "effect";

export class StackFunctionsBundleError extends Data.TaggedError("StackFunctionsBundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Bundles the stack runtime's Functions entrypoint for an offline native stack. */
export const bundleStackFunctionsServeMainTemplate = Effect.fn(
  "StackFunctionsBundler.bundleServeMainTemplate",
)(function* () {
  const entrypoint = fileURLToPath(
    import.meta.resolve("@supabase/stack/internal/functions/serve-main"),
  );
  const result = yield* Effect.tryPromise({
    try: () =>
      build({
        entryPoints: [entrypoint],
        bundle: true,
        format: "esm",
        platform: "browser",
        minify: true,
        write: false,
        legalComments: "none",
        logLevel: "silent",
      }),
    catch: (cause) =>
      new StackFunctionsBundleError({
        message: "Unable to bundle the stack Functions runtime",
        cause,
      }),
  });
  const output = result.outputFiles[0]?.text;
  if (output === undefined)
    return yield* new StackFunctionsBundleError({
      message: "esbuild produced no stack Functions template",
    });
  return output;
});

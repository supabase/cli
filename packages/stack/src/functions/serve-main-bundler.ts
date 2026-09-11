import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { Data, Effect } from "effect";

class ServeMainBundleError extends Data.TaggedError("ServeMainBundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Absolute path to the stack-owned Edge Runtime main service template. */
export const serveMainEntrypoint = fileURLToPath(new URL("./serve.main.ts", import.meta.url));

/** Produces one offline ES module with jose and path helpers inlined. */
export const bundleServeMainTemplate = Effect.gen(function* () {
  const result = yield* Effect.tryPromise({
    try: () =>
      build({
        entryPoints: [serveMainEntrypoint],
        bundle: true,
        format: "esm",
        platform: "browser",
        minify: true,
        write: false,
        legalComments: "none",
        logLevel: "silent",
      }),
    catch: (cause) =>
      new ServeMainBundleError({ message: "Unable to bundle functions bootstrap", cause }),
  });
  const output = result.outputFiles[0]?.text;
  if (output === undefined)
    return yield* new ServeMainBundleError({
      message: "esbuild produced no functions bootstrap output",
    });
  return output;
}).pipe((buildProgram) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.exit(restore(buildProgram)), (result) =>
      Effect.tryPromise({
        try: () => stop(),
        catch: (cause) => new ServeMainBundleError({ message: "Unable to stop esbuild", cause }),
      }).pipe(Effect.andThen(result)),
    ),
  ),
);

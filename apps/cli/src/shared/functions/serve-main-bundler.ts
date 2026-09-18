import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Data, Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class ServeMainBundleError extends Data.TaggedError("ServeMainBundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.unknown;
  }
}

/**
 * Absolute path to the edge-runtime bootstrap template. The template runs verbatim
 * inside the edge-runtime (Deno) container as `/root/index.ts`.
 */
const serveMainEntrypoint = fileURLToPath(new URL("./serve.main.ts", import.meta.url));

/**
 * Bundles `serve.main.ts` into a single self-contained ES module with all
 * dependencies inlined, so the runtime entrypoint needs no network access
 * (the template previously resolved `deno.land/std`/`jsr:` imports over the
 * network on every container start, breaking offline `functions serve` —
 * supabase/supabase#45570).
 *
 * `platform: "browser"` selects `jose`'s Web Crypto build for the
 * edge-runtime's Deno; `Deno` and `EdgeRuntime` are left as free globals.
 */
export const bundleServeMainTemplate = Effect.tryPromise({
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
}).pipe(
  Effect.flatMap((result) => {
    const output = result.outputFiles[0]?.text;
    return output === undefined
      ? Effect.fail(
          new ServeMainBundleError({
            message: "esbuild produced no output for the functions serve runtime template",
          }),
        )
      : Effect.succeed(output);
  }),
);

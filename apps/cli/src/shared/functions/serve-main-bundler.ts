import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * Absolute path to the edge-runtime bootstrap template. The template runs verbatim
 * inside the edge-runtime (Deno) container as `/root/index.ts`.
 */
const serveMainEntrypoint = fileURLToPath(new URL("./serve.main.ts", import.meta.url));

/**
 * Bundle `serve.main.ts` into a single self-contained ES module string with all of
 * its dependencies inlined.
 *
 * The template used to import `deno.land/std` and `jsr:` modules that Deno resolved
 * over the network on every container start, breaking `functions serve` offline
 * (supabase/supabase#45570). Bundling inlines `jose` and the local `serve-main-deps`
 * helpers so the runtime entrypoint needs no network access.
 *
 * `platform: "browser"` selects `jose`'s Web Crypto build, which runs under the
 * edge-runtime's Deno. `Deno` and `EdgeRuntime` are left as free globals.
 */
export async function bundleServeMainTemplate(): Promise<string> {
  const result = await build({
    entryPoints: [serveMainEntrypoint],
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: true,
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) {
    throw new Error("esbuild produced no output for the functions serve runtime template");
  }
  return output;
}

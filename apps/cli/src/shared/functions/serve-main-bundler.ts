import { fileURLToPath } from "node:url";

import { build } from "esbuild";

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

// oxlint-disable effecttsgo/async-function -- esbuild's public API is Promise-based.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Absolute path to the stack-owned Edge Runtime main service template. */
export const serveMainEntrypoint = fileURLToPath(new URL("./serve.main.ts", import.meta.url));

/** Produces one offline ES module with jose and path helpers inlined. */
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
  if (output === undefined) throw new Error("esbuild produced no functions bootstrap output");
  return output;
}

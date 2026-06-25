import { $ } from "bun";
import process from "node:process";

import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";

/**
 * Compile a single CLI shell to a standalone binary, embedding the pre-bundled
 * edge-runtime template via the `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` define so
 * the binary serves Functions offline without bundling at runtime
 * (supabase/supabase#45570). Used by the `build:next` / `build:legacy` scripts; the
 * multi-target release build in `build.ts` injects the same define.
 */
const shell = process.argv[2];
if (shell !== "next" && shell !== "legacy") {
  throw new Error(`expected shell "next" or "legacy", received "${shell ?? ""}"`);
}

const entrypoint = `src/${shell}/main.ts`;
const outfile = `dist/supabase-${shell}`;
const defineArg = `--define=SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE=${JSON.stringify(
  await bundleServeMainTemplate(),
)}`;

await $`bun build ${entrypoint} --compile ${defineArg} --outfile ${outfile}`;

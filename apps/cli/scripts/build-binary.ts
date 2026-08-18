import { $ } from "bun";
import process from "node:process";

import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";
import { workerStacks } from "../src/shared/workers/worker-stacks.ts";

/**
 * Compile a single CLI shell to a standalone binary, embedding the pre-bundled
 * edge-runtime template via the `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` define so
 * the binary serves Functions offline without bundling at runtime
 * (supabase/supabase#45570), and the worker starter files via
 * `SUPABASE_WORKER_STACKS` so `workers new` can scaffold without a `stacks/`
 * directory on disk. Used by the `build:next` / `build:legacy` scripts; the
 * multi-target release build in `build.ts` injects the same defines — miss one
 * there and the shipped binary scaffolds nothing while dev and CI stay green.
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
const stacksDefineArg = `--define=SUPABASE_WORKER_STACKS=${JSON.stringify(
  JSON.stringify(workerStacks()),
)}`;

await $`bun build ${entrypoint} --compile ${defineArg} ${stacksDefineArg} --outfile ${outfile}`;

import { $ } from "bun";

import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";

/**
 * Compile the legacy CLI shell to a standalone binary, embedding the pre-bundled
 * edge-runtime template via the `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` define so
 * the binary serves Functions offline without bundling at runtime
 * (supabase/supabase#45570). Used by the `build:legacy` script; the multi-target
 * release build in `build.ts` injects the same define.
 */
const entrypoint = "src/legacy/main.ts";
const outfile = "dist/supabase-legacy";
const packageJson = JSON.parse(
  await Bun.file(new URL("../package.json", import.meta.url)).text(),
) as {
  version?: string;
};
if (packageJson.version === undefined || packageJson.version.length === 0) {
  throw new Error("CLI package version is required for a compiled build");
}
const versionDefine = `--define=SUPABASE_CLI_VERSION=${JSON.stringify(packageJson.version)}`;
const defineArg = `--define=SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE=${JSON.stringify(
  await bundleServeMainTemplate(),
)}`;

await $`bun build ${entrypoint} --compile ${versionDefine} ${defineArg} --outfile ${outfile}`;

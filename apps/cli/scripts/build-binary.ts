import { $ } from "bun";

import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";

/**
 * Compiles the CLI to a standalone binary, run via `pnpm build:binary`. Embeds the pre-bundled
 * edge-runtime template through `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` so Functions serve
 * offline without bundling at runtime (supabase/supabase#45570).
 */
const entrypoint = "src/main.ts";
const outfile = "dist/supabase";
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

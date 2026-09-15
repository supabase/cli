import { $ } from "bun";
import { Effect } from "effect";

import { bundleServeMainTemplate as bundleStackServeMainTemplate } from "../../../packages/stack/src/functions/serve-main-bundler.ts";
import { bundleServeMainTemplate as bundleLegacyServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";

/**
 * Compiles the CLI to a standalone binary, embedding the legacy and managed-stack Edge Runtime
 * templates so both Functions serve implementations work offline without runtime bundling.
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
  await bundleLegacyServeMainTemplate(),
)}`;
const stackDefineArg = `--define=SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE=${JSON.stringify(
  await Effect.runPromise(bundleStackServeMainTemplate),
)}`;

await $`bun build ${entrypoint} --compile ${versionDefine} ${defineArg} ${stackDefineArg} --outfile ${outfile}`;

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
const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: { outfile },
  define: {
    SUPABASE_CLI_VERSION: JSON.stringify(packageJson.version),
    SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: JSON.stringify(await bundleLegacyServeMainTemplate()),
    SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE: JSON.stringify(
      await Effect.runPromise(bundleStackServeMainTemplate),
    ),
  },
});
if (!result.success) {
  const messages = result.logs.map((log) => log.message).join("\n");
  throw new Error(`CLI binary build failed:\n${messages}`);
}

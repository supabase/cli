#!/usr/bin/env bun
import { bundleStackFunctionsServeMainTemplate } from "../src/command-internal/stack-functions-bundler.ts";
import { Effect } from "effect";
import { oxfmtStubPlugin } from "./bundle-externals.ts";
import { compileOptions } from "./compile-options.ts";

const outfile = "apps/cli/dist/startup-api";
const result = await Bun.build({
  entrypoints: [new URL("./startup-api.ts", import.meta.url).pathname],
  compile: { outfile },
  ...compileOptions,
  plugins: [oxfmtStubPlugin],
  define: {
    SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE: JSON.stringify(
      await Effect.runPromise(bundleStackFunctionsServeMainTemplate()),
    ),
  },
});
for (const log of result.logs) process.stderr.write(`${log.message}\n`);
if (!result.success) process.exitCode = 1;

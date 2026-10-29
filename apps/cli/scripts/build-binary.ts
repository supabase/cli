import { Console, Effect } from "effect";
import { compileOptions, localBuildDefine } from "./compile-options.ts";

/**
 * Compiles the CLI to a standalone binary, run via `pnpm build:binary`. Embeds the pre-bundled
 * edge-runtime template through `SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE` so Functions serve
 * offline without bundling at runtime (supabase/supabase#45570).
 */
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  compile: { outfile: "dist/supabase" },
  ...compileOptions,
  define: await Effect.runPromise(localBuildDefine),
});
for (const log of result.logs) {
  Effect.runSync(Console.warn(log));
}

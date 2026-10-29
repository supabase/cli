import { Console, Effect } from "effect";
import { localBuildDefine } from "./compile-options.ts";

/**
 * Bundles the CLI for Node.js into `dist-node/main.js`, run via `pnpm build:node`. The keyring
 * native addons are emitted beside the bundle, which loads them from there at runtime.
 */
const outdir = "dist-node";
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir,
  target: "node",
  format: "esm",
  external: ["oxfmt"],
  define: await Effect.runPromise(localBuildDefine),
});
for (const log of result.logs) {
  Effect.runSync(Console.warn(log));
}
const bundle = Bun.file(`${outdir}/main.js`);
await Bun.write(bundle, (await bundle.text()).replace(/^#!.*\n/, "#!/usr/bin/env node\n"));

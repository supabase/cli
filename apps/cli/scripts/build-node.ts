import { Console, Effect } from "effect";
import { localBuildDefine } from "./compile-options.ts";

/**
 * Bundles the CLI for Node.js into `dist-node/main.js`, run via `pnpm build:node`. The keyring
 * native addons and libpg-query's wasm are emitted beside the bundle, which loads them from there.
 */
const outdir = "dist-node";

/**
 * Ships libpg-query's wasm beside the bundle and loads it from there. Bun loads the parser's
 * CommonJS entry for Node, which pins the wasm to the build host's path, and emits the patched file
 * import with a path relative to the working directory.
 */
const libPgQueryWasmBesideBundle: Bun.BunPlugin = {
  name: "libpg-query-wasm-beside-bundle",
  setup(build) {
    build.onResolve({ filter: /^@libpg-query\/parser$/ }, (args) => ({
      path: Bun.resolveSync("@libpg-query/parser/wasm/index.js", args.importer),
    }));
    build.onResolve({ filter: /^\.\/libpg-query\.wasm$/ }, (args) =>
      args.importer.endsWith("/@libpg-query/parser/wasm/index.js")
        ? {
            path: Bun.fileURLToPath(new URL(args.path, Bun.pathToFileURL(args.importer))),
            namespace: "beside-bundle",
          }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "beside-bundle" }, (args) =>
      Bun.write(`${outdir}/libpg-query.wasm`, Bun.file(args.path)).then(() => ({
        loader: "js",
        contents: `import { fileURLToPath } from "node:url";
export default fileURLToPath(new URL("./libpg-query.wasm", import.meta.url));`,
      })),
    );
  },
};

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir,
  target: "node",
  format: "esm",
  external: ["oxfmt"],
  plugins: [libPgQueryWasmBesideBundle],
  define: await Effect.runPromise(localBuildDefine),
});
for (const log of result.logs) {
  Effect.runSync(Console.warn(log));
}
const bundle = Bun.file(`${outdir}/main.js`);
await Bun.write(bundle, (await bundle.text()).replace(/^#!.*\n/, "#!/usr/bin/env node\n"));

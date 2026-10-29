import { Console, Effect } from "effect";
import { localBuildDefine } from "./compile-options.ts";

/**
 * Bundles the CLI for Node.js into `dist-node/main.js`, run via `pnpm build:node`. The keyring
 * native addons are emitted beside the bundle, which loads them from there at runtime.
 */
const outdir = "dist-node";

/**
 * Embeds libpg-query's wasm bytes in the bundle. Bun loads the parser's CommonJS entry for Node,
 * which pins the wasm to the build host's path, and emits the patched file import with a path
 * relative to the working directory.
 */
const embedLibPgQueryWasm: Bun.BunPlugin = {
  name: "embed-libpg-query-wasm",
  setup(build) {
    build.onResolve({ filter: /^@libpg-query\/parser$/ }, (args) => ({
      path: Bun.resolveSync("@libpg-query/parser/wasm/index.js", args.importer),
    }));
    build.onResolve({ filter: /^\.\/libpg-query\.wasm$/ }, (args) =>
      args.importer.endsWith("/@libpg-query/parser/wasm/index.js")
        ? {
            path: Bun.fileURLToPath(new URL(args.path, Bun.pathToFileURL(args.importer))),
            namespace: "wasm-bytes",
          }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "wasm-bytes" }, (args) =>
      Bun.file(args.path)
        .bytes()
        .then((bytes) => ({
          loader: "js",
          contents: `export default Buffer.from("${bytes.toBase64()}", "base64");`,
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
  plugins: [embedLibPgQueryWasm],
  define: await Effect.runPromise(localBuildDefine),
});
for (const log of result.logs) {
  Effect.runSync(Console.warn(log));
}
const bundle = Bun.file(`${outdir}/main.js`);
await Bun.write(bundle, (await bundle.text()).replace(/^#!.*\n/, "#!/usr/bin/env node\n"));

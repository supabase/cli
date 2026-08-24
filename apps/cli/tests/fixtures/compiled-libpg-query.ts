// Deliberately mirrors production's import shape: @supabase/pg-delta never
// imports @supabase/pg-topo eagerly. It reaches it only through the literal
// dynamic `import("@supabase/pg-topo")` inside its bundled
// dist/frontends/sql-order.js, invoked from `analyzeForShadow`. Calling
// `analyzeForShadow` here — instead of importing pg-topo directly — proves
// Bun's `--compile` traces that dynamic import inside pg-delta's dist and
// still embeds the libpg-query WASM asset it ultimately depends on.
import { analyzeForShadow } from "@supabase/pg-delta/sql-order";

const embeddedParser = Bun.embeddedFiles.find((file) => file.type === "application/wasm");

if (!embeddedParser) {
  throw new Error("libpg-query.wasm was not embedded in the executable");
}

const wasmBytes = new Uint8Array(await embeddedParser.arrayBuffer());
if (
  wasmBytes[0] !== 0x00 ||
  wasmBytes[1] !== 0x61 ||
  wasmBytes[2] !== 0x73 ||
  wasmBytes[3] !== 0x6d
) {
  throw new Error("the embedded libpg-query asset is not WebAssembly");
}

const result = await analyzeForShadow([{ name: "0001_select.sql", sql: "select 1;" }]);
if (result.files.length !== 1) {
  throw new Error("analyzeForShadow did not reorder the expected statement");
}

process.stdout.write("libpg-query.wasm loaded\n");

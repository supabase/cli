import { validateSqlSyntax } from "@supabase/pg-topo";
import "@supabase/pg-delta/core";

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

await validateSqlSyntax("select 1");
console.log("libpg-query.wasm loaded");

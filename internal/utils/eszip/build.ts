import * as path from "https://deno.land/std@0.127.0/path/mod.ts";
import { writeAll } from "https://deno.land/std@0.162.0/streams/conversion.ts";
import { compress } from "https://deno.land/x/brotli@0.1.7/mod.ts";

import { build } from "https://deno.land/x/eszip@v0.30.0/mod.ts";
import { load } from "https://deno.land/x/eszip@v0.30.0/loader.ts";

const virtualBasePath = "file:///src/";

async function buildAndWrite(p: string) {
  const entrypoint = new URL("index.ts", virtualBasePath).href;
  const eszip = await build([entrypoint], async (specifier: string) => {
    const url = new URL(specifier);
    if (url.protocol === 'file:') {
      console.error(specifier)
      // if the path is `file:///*`, treat it as a path from parent directory
      let actualPath = specifier.replace('file:///', `./${path.dirname(p)}/../`);
      // if the path is `file:///src/*`, treat it as a relative path from current dir
      if (specifier.startsWith(virtualBasePath)) {
        actualPath = specifier.replace(virtualBasePath, `./${path.dirname(p)}/`);
      }
      const content = await Deno.readTextFile((actualPath));
      return {
        kind: "module",
        specifier,
        content
      }
    } 

    return load(specifier);
  });
  // compress ESZIP payload using Brotli
  const compressed = compress(eszip);

  // add a marker frame to the start of the payload
  const marker = new TextEncoder().encode("EZBR");

  const combinedPayload = new Uint8Array(marker.length + compressed.length);
  combinedPayload.set(marker);
  combinedPayload.set(compressed, marker.length);

  await writeAll(Deno.stdout, combinedPayload);
}

buildAndWrite(Deno.args[0]);

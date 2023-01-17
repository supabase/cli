import * as path from "https://deno.land/std@0.127.0/path/mod.ts";
import { readAll } from "https://deno.land/std@0.162.0/streams/conversion.ts";
import { decompress } from "https://deno.land/x/brotli@0.1.7/mod.ts";

import { Parser } from "https://deno.land/x/eszip@v0.30.0/mod.ts";

function url2path(url: string) {
  return path.join(...(new URL(url).pathname.replace("/src", "").split("/").filter(Boolean)));
}

async function write(p: string, content: string) {
  await Deno.mkdir(path.dirname(p), { recursive: true });
  await Deno.writeTextFile(p, content);
}

async function loadEszip(bytes: Uint8Array) {
  const parser = await Parser.createInstance();
  const specifiers = await parser.parseBytes(bytes);
  await parser.load();
  return { parser, specifiers };
}

async function extractEszip(dest: string, parser, specifiers) {
  const imports = {};

  for (const specifier of specifiers) {
    // skip remote dependencies
    if (!specifier.startsWith("file:")) {
      continue;
    }
    const module = await parser.getModuleSource(specifier);
    await write(path.join(dest, url2path(specifier)), module);
  }
}

async function extractSource(dest: string) {
  const buf = await readAll(Deno.stdin);
  // response is compressed with Brotli
  const decompressed = decompress(buf);
  const { parser, specifiers } = await loadEszip(decompressed);
  await extractEszip(dest, parser, specifiers);
}

extractSource(Deno.args[0]);

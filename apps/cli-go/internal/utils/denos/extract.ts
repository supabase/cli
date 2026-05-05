import * as path from "https://deno.land/std@0.127.0/path/mod.ts";
import { readAll } from "https://deno.land/std@0.162.0/streams/conversion.ts";
import { Parser } from "https://deno.land/x/eszip@v0.30.0/mod.ts";

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

async function extractEszip(
  destPath: string,
  entrypointUrl: string,
  parser: Parser,
  specifiers: string[],
) {
  const entrypointPath = path.fromFileUrl(entrypointUrl);
  const basePath = path.dirname(entrypointPath);
  for (const specifier of specifiers) {
    // skip remote dependencies
    if (!specifier.startsWith("file:")) {
      continue;
    }
    console.error(specifier);
    const module = await parser.getModuleSource(specifier);
    const absPath = path.fromFileUrl(specifier);
    const relPath = path.relative(basePath, absPath);
    const dest = path.join(destPath, relPath);
    console.info(path.resolve(dest));
    await write(dest, module);
  }
}

async function extractSource(destPath: string, entrypointUrl: string) {
  const buf = await readAll(Deno.stdin);

  const { parser, specifiers } = await loadEszip(buf);
  await extractEszip(destPath, entrypointUrl, parser, specifiers);
}

extractSource(...Deno.args);

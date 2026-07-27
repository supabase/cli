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
  rootPath: string,
  parser: Parser,
  specifiers: string[],
) {
  const entrypointPath = path.fromFileUrl(entrypointUrl);
  const basePath = path.dirname(entrypointPath);
  // Containment is enforced against rootPath (the shared functions
  // directory), not destPath (this function's own directory): a common
  // layout imports a sibling like "../_shared/cors.ts", which legitimately
  // resolves one level above destPath, but must never resolve outside
  // rootPath entirely.
  const resolvedRoot = path.resolve(rootPath);
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

    const resolvedDest = path.resolve(dest);
    const relToRoot = path.relative(resolvedRoot, resolvedDest);
    if (
      relToRoot === ".." ||
      relToRoot.startsWith(`..${path.SEP}`) ||
      path.isAbsolute(relToRoot)
    ) {
      throw new Error(
        `Refusing to extract "${specifier}" outside of ${rootPath}`,
      );
    }

    console.info(path.resolve(dest));
    await write(dest, module);
  }
}

async function extractSource(
  destPath: string,
  entrypointUrl: string,
  rootPath: string,
) {
  const buf = await readAll(Deno.stdin);

  const { parser, specifiers } = await loadEszip(buf);
  await extractEszip(destPath, entrypointUrl, rootPath, parser, specifiers);
}

extractSource(...Deno.args);

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const ARTIFACT_EXTS = [".tar.gz", ".zip", ".deb", ".rpm", ".apk"] as const;

export async function generateChecksums(opts: {
  version: string;
  distDir: string;
}): Promise<{ filename: string; hash: string }[]> {
  const { version, distDir } = opts;
  const prefix = `supabase_${version}_`;

  const entries = await readdir(distDir);
  const files = entries
    .filter((name) => name.startsWith(prefix) && ARTIFACT_EXTS.some((ext) => name.endsWith(ext)))
    .sort();

  if (files.length === 0) {
    throw new Error(`No release artifacts matching ${prefix}* found in ${distDir}.`);
  }

  const results: { filename: string; hash: string }[] = [];
  for (const filename of files) {
    const data = await readFile(path.join(distDir, filename));
    const hash = createHash("sha256").update(data).digest("hex");
    results.push({ filename, hash });
  }

  const lines = results.map(({ filename, hash }) => `${hash}  ${filename}`);
  const checksumsPath = path.join(distDir, "checksums.txt");
  await writeFile(checksumsPath, `${lines.join("\n")}\n`);
  console.log(`Checksums written to ${checksumsPath} (${results.length} files)`);

  return results;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
    },
  });

  const version = values.version;
  if (!version) {
    console.error("Usage: pnpm exec bun apps/cli/scripts/checksums.ts --version <version>");
    process.exit(1);
  }

  const root = path.resolve(import.meta.dir, "../../..");
  const distDir = path.join(root, "dist");

  await generateChecksums({ version, distDir });
}

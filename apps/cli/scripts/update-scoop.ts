import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { buildScoopManifest, readChecksums } from "./lib/scoop-manifest.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/cli" },
    bucket: { type: "string", default: "supabase/scoop-bucket" },
    name: { type: "string", default: "supabase" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: bun run scripts/update-scoop.ts --version <version> [--repo <owner/repo>] [--bucket <owner/repo>] [--name <manifest-name>] [--local] [--dry-run]",
  );
  process.exit(1);
}

const repo = values.repo!;
const bucket = values.bucket!;
const name = values.name!;
const local = values.local!;
const dryRun = values["dry-run"]!;

// The shipped binary is always `supabase.exe`, regardless of channel — only
// the manifest filename differs (e.g. `supabase-beta.json`) so stable and
// beta can coexist in the same bucket. Matches the Go CLI's historical
// scoop-bucket layout (`supabase.json` and `supabase-beta.json` both shim
// `supabase.exe`).
const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

const checksums = await readChecksums(path.join(distDir, "checksums.txt"));
const { json: manifestJson } = buildScoopManifest({
  version,
  repo,
  checksums,
  local,
  distDir,
});

const manifestFileName = `${name}.json`;
const manifestOut = path.join(distDir, manifestFileName);
await writeFile(manifestOut, manifestJson);
console.log(`Manifest written to ${manifestOut}`);

if (local || dryRun) {
  console.log(manifestJson);
  process.exit(0);
}

// Clone bucket repo, update manifest, commit, push
const tmpDir = await mkdtemp(path.join(tmpdir(), "scoop-bucket-"));
try {
  await $`gh repo clone ${bucket} ${tmpDir}`;

  const bucketManifestPath = path.join(tmpDir, manifestFileName);
  await writeFile(bucketManifestPath, manifestJson);

  await $`git -C ${tmpDir} add ${manifestFileName}`;
  await $`git -C ${tmpDir} commit -m ${name + " " + version}`;
  await $`git -C ${tmpDir} push`;

  console.log(`Pushed manifest update to ${bucket}`);
} finally {
  await rm(tmpDir, { recursive: true });
}

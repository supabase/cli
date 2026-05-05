import { $ } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

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

// When name != "supabase", rename the binary on install so it doesn't clash
// with the official `supabase` CLI a user may already have installed.
// Scoop's `bin` field accepts either a string (no rename) or a
// [source, alias] tuple. See https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests#bin
const binEntry: string | [string, string] =
  name === "supabase" ? "supabase.exe" : ["supabase.exe", name];
const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

// Parse checksums
const checksums = new Map<string, string>();
const checksumsText = await readFile(path.join(distDir, "checksums.txt"), "utf-8");
for (const line of checksumsText.trim().split("\n")) {
  const [hash, file] = line.split(/\s+/) as [string, string];
  checksums.set(file, hash);
}

function sha(file: string): string {
  const hash = checksums.get(file);
  if (!hash) throw new Error(`Checksum not found for ${file}`);
  return hash;
}

// Scoop supports file:// URLs for local testing
const baseUrl = local
  ? `file:///${distDir.replace(/\\/g, "/")}`
  : `https://github.com/${repo}/releases/download/v${version}`;

const manifest = {
  version,
  description: "Supabase CLI",
  homepage: "https://supabase.com",
  license: "MIT",
  architecture: {
    "64bit": {
      url: `${baseUrl}/supabase_${version}_windows_amd64.zip`,
      hash: sha(`supabase_${version}_windows_amd64.zip`),
      bin: [binEntry],
    },
    arm64: {
      url: `${baseUrl}/supabase_${version}_windows_arm64.zip`,
      hash: sha(`supabase_${version}_windows_arm64.zip`),
      bin: [binEntry],
    },
  },
  checkver: {
    github: `https://github.com/${repo}`,
  },
  autoupdate: {
    architecture: {
      "64bit": {
        url: `https://github.com/${repo}/releases/download/v$version/supabase_$version_windows_amd64.zip`,
      },
      arm64: {
        url: `https://github.com/${repo}/releases/download/v$version/supabase_$version_windows_arm64.zip`,
      },
    },
  },
};

const manifestFileName = `${name}.json`;
const manifestJson = `${JSON.stringify(manifest, null, 4)}\n`;
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

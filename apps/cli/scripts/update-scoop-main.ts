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
    fork: { type: "string", default: "supabase/scoop-main" },
    upstream: { type: "string", default: "ScoopInstaller/Main" },
    "upstream-branch": { type: "string", default: "master" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: bun run scripts/update-scoop-main.ts --version <version> [--repo <owner/repo>] [--fork <owner/repo>] [--upstream <owner/repo>] [--upstream-branch <branch>] [--local] [--dry-run]",
  );
  process.exit(1);
}

const repo = values.repo!;
const fork = values.fork!;
const upstream = values.upstream!;
const upstreamBranch = values["upstream-branch"]!;
const local = values.local!;
const dryRun = values["dry-run"]!;

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

console.log(`Built scoop manifest for ${repo}@${version}`);

if (local || dryRun) {
  console.log(manifestJson);
  process.exit(0);
}

const branch = `supabase-${version}`;
const manifestPathInRepo = "bucket/supabase.json";

const tmpDir = await mkdtemp(path.join(tmpdir(), "scoop-main-"));
try {
  await $`gh repo clone ${fork} ${tmpDir}`;

  // Sync fork's master with upstream so the PR diff is clean.
  await $`git -C ${tmpDir} remote add upstream https://github.com/${upstream}.git`;
  await $`git -C ${tmpDir} fetch upstream ${upstreamBranch}`;
  await $`git -C ${tmpDir} checkout ${upstreamBranch}`;
  await $`git -C ${tmpDir} reset --hard upstream/${upstreamBranch}`;
  await $`git -C ${tmpDir} push origin ${upstreamBranch} --force-with-lease`;

  // Branch off the synced base.
  await $`git -C ${tmpDir} checkout -B ${branch}`;

  await writeFile(path.join(tmpDir, manifestPathInRepo), manifestJson);

  // If the manifest is already current upstream (e.g. the excavator bot
  // landed this version first), bail out cleanly.
  const diff = await $`git -C ${tmpDir} status --porcelain ${manifestPathInRepo}`.text();
  if (diff.trim() === "") {
    console.log(`${upstream}/${manifestPathInRepo} already at ${version}; nothing to do.`);
    process.exit(0);
  }

  await $`git -C ${tmpDir} add ${manifestPathInRepo}`;
  await $`git -C ${tmpDir} commit -m ${`supabase: Update to version ${version}`}`;
  await $`git -C ${tmpDir} push origin ${branch} --force-with-lease`;

  // Open a PR upstream. If one already exists for this head ref, gh
  // will print an error — treat that as success.
  const forkOwner = fork.split("/")[0];
  const title = `supabase@${version}: Update to ${version}`;
  const body = `Bumps the \`supabase\` manifest to v${version}.\n\nSee https://github.com/${repo}/releases/tag/v${version}.`;

  const pr =
    await $`gh pr create --repo ${upstream} --base ${upstreamBranch} --head ${forkOwner}:${branch} --title ${title} --body ${body}`.nothrow();
  if (pr.exitCode !== 0) {
    const stderr = pr.stderr.toString();
    if (stderr.includes("already exists")) {
      console.log(`PR for ${forkOwner}:${branch} already open; skipping.`);
    } else {
      console.error(stderr);
      process.exit(pr.exitCode);
    }
  } else {
    console.log(pr.stdout.toString());
  }
} finally {
  await rm(tmpDir, { recursive: true });
}

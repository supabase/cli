import { $ } from "bun";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    "pr-target": { type: "string", default: "upstream" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: bun run scripts/update-scoop-main.ts --version <version> [--repo <owner/repo>] [--fork <owner/repo>] [--upstream <owner/repo>] [--upstream-branch <branch>] [--pr-target <upstream|fork>] [--local] [--dry-run]",
  );
  process.exit(1);
}

const repo = values.repo!;
const fork = values.fork!;
const upstream = values.upstream!;
const upstreamBranch = values["upstream-branch"]!;
const prTarget = values["pr-target"]!;
const local = values.local!;
const dryRun = values["dry-run"]!;

if (prTarget !== "upstream" && prTarget !== "fork") {
  console.error(`Invalid --pr-target: ${prTarget} (expected "upstream" or "fork")`);
  process.exit(1);
}

const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

// In-pipeline runs have checksums.txt next to the build artifacts; --local
// builds do too. Manual runs against an already-published tag fetch it from
// the GitHub release — same source of truth, no rebuild required.
async function resolveChecksums(): Promise<{
  checksums: Map<string, string>;
  cleanup?: () => Promise<void>;
}> {
  const localPath = path.join(distDir, "checksums.txt");
  try {
    await access(localPath);
    return { checksums: await readChecksums(localPath) };
  } catch {
    if (local) {
      throw new Error(
        `--local set but ${localPath} not found; build locally before running with --local.`,
      );
    }
  }
  const dlDir = await mkdtemp(path.join(tmpdir(), "scoop-checksums-"));
  console.log(`Fetching checksums.txt from ${repo} release v${version}…`);
  await $`gh release download v${version} --repo ${repo} --pattern checksums.txt --dir ${dlDir}`;
  const checksums = await readChecksums(path.join(dlDir, "checksums.txt"));
  return { checksums, cleanup: () => rm(dlDir, { recursive: true }) };
}

const { checksums, cleanup: cleanupChecksums } = await resolveChecksums();
try {
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

    // Sync fork's master with upstream so the PR diff is just our bump.
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

    // PR target:
    //   upstream  → cross-repo PR from fork branch to ScoopInstaller/Main
    //              (the real production flow on stable release)
    //   fork      → in-repo PR within the fork (manual testing path:
    //              exercises the whole pipeline without touching upstream)
    const forkOwner = fork.split("/")[0];
    const title = `supabase@${version}: Update to ${version}`;
    const body = `Bumps the \`supabase\` manifest to v${version}.\n\nSee https://github.com/${repo}/releases/tag/v${version}.`;
    const targetRepo = prTarget === "upstream" ? upstream : fork;
    const head = prTarget === "upstream" ? `${forkOwner}:${branch}` : branch;

    const pr =
      await $`gh pr create --repo ${targetRepo} --base ${upstreamBranch} --head ${head} --title ${title} --body ${body}`.nothrow();
    if (pr.exitCode !== 0) {
      const stderr = pr.stderr.toString();
      if (stderr.includes("already exists")) {
        console.log(`PR for ${head} → ${targetRepo} already open; skipping.`);
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
} finally {
  await cleanupChecksums?.();
}

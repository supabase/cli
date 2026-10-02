#!/usr/bin/env bun
// Re-derives a GitHub Release's changelog from its tag's commit using the
// current semantic-release config, regardless of what apps/cli/package.json
// looked like when the tag was cut. Used both as a local debugging tool and
// as the engine behind .github/workflows/backfill-release-notes.yml.
//
// Backfilling an old tag trips semantic-release on several fronts at once: it
// picks the wrong branch from CI env vars, can't read channel notes for
// historical tags, refuses to proceed when the local branch is "behind" the
// real remote, and uses whatever release config existed at the tag's commit.
// The script works around each of those in a temp clone so the original
// workspace stays clean.
//
// Usage:
//   bun apps/cli/scripts/backfill-release-notes.ts --tag v2.99.0-beta.1
//   bun apps/cli/scripts/backfill-release-notes.ts --tag v2.100.1 --apply
//
//   --tag    Required. Release tag to refresh (e.g. v2.99.0-beta.1).
//   --apply  Update the GitHub Release body via `gh release edit`.
//            Without it, raw markdown notes are printed to stdout.
import { $ } from "bun";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import semanticRelease from "semantic-release";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    apply: { type: "boolean", default: false },
  },
  strict: true,
});

const tag = values.tag;
if (!tag) {
  console.error("--tag is required (e.g. --tag v2.99.0-beta.1)");
  process.exit(2);
}
const apply = values.apply ?? false;

const repoRoot = (await $`git rev-parse --show-toplevel`.text()).trim();
const cliDir = path.join(repoRoot, "apps/cli");

const rootPkg = JSON.parse(await readFile(path.join(cliDir, "package.json"), "utf8"));

function releasePluginSpecifier(plugin: unknown): string | undefined {
  if (typeof plugin === "string") return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === "string") return plugin[0];
  return undefined;
}

async function copyLocalReleasePlugins(clone: string): Promise<void> {
  const plugins = Array.isArray(rootPkg.release?.plugins) ? rootPkg.release.plugins : [];
  const historicalCliDir = path.join(clone, "apps/cli");

  for (const plugin of plugins) {
    const specifier = releasePluginSpecifier(plugin);
    if (!specifier || path.isAbsolute(specifier) || !specifier.startsWith(".")) continue;

    const sourcePath = path.resolve(cliDir, specifier);
    const relativePath = path.relative(cliDir, sourcePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Local release plugin must stay inside apps/cli: ${specifier}`);
    }

    const destinationPath = path.join(historicalCliDir, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

const repoField = rootPkg.repository?.url ?? rootPkg.repository ?? "";
const repoUrl = `${String(repoField)
  .replace(/^git\+/, "")
  .replace(/\.git$/, "")
  .replace(/\/$/, "")}.git`;
if (!repoUrl.startsWith("http")) {
  console.error(`Could not derive repository URL from apps/cli/package.json (got: ${repoUrl})`);
  process.exit(1);
}

const tagCheck = await $`git rev-parse -q --verify refs/tags/${tag}`
  .cwd(repoRoot)
  .nothrow()
  .quiet();
if (tagCheck.exitCode !== 0) {
  console.error(`Tag ${tag} not found locally. Try: git fetch --tags origin`);
  process.exit(1);
}

const branch = tag.includes("-beta.") ? "develop" : "main";

const work = await mkdtemp(path.join(tmpdir(), "backfill-release-notes."));
const clone = path.join(work, "repo");

try {
  console.error(`==> Cloning ${repoRoot} -> ${clone}`);
  await $`git clone --quiet --no-local ${repoRoot} ${clone}`;

  // `git notes add` (used below to seed channel notes) requires a committer
  // identity, which CI runners don't ship in ~/.gitconfig.
  await $`git -C ${clone} config --local user.email backfill-release-notes@supabase.local`;
  await $`git -C ${clone} config --local user.name backfill-release-notes`;
  // A signing key inherited from a user's global config would also make
  // `git notes add` fail; the temp clone never publishes anything, so disable it.
  await $`git -C ${clone} config --local commit.gpgsign false`;
  await $`git -C ${clone} config --local tag.gpgsign false`;

  const originUrl = (await $`git -C ${repoRoot} remote get-url origin`.text()).trim();

  // Notes refs aren't fetched by `git clone`. Pull from the source repo first
  // (network-free), then from origin so even tags whose notes haven't been
  // sync'd locally yet are available.
  await $`git -C ${clone} fetch --no-tags --quiet ${repoRoot} +refs/notes/*:refs/notes/*`
    .nothrow()
    .quiet();
  await $`git -C ${clone} fetch --no-tags --quiet ${originUrl} +refs/notes/*:refs/notes/*`
    .nothrow()
    .quiet();
  await $`git -C ${clone} fetch --no-tags --quiet ${originUrl} +refs/heads/main:refs/remotes/origin/main +refs/heads/develop:refs/remotes/origin/develop`
    .nothrow()
    .quiet();

  const sha = (await $`git -C ${clone} rev-list -n 1 ${tag}`.text()).trim();
  // Delete the target tag and any other local tag pointing at the same commit:
  // when a stable and a beta share a commit, semantic-release picks the
  // higher-semver one as lastRelease (which becomes HEAD itself, leaving "no
  // release"). Dropping the co-incident tags falls back to the genuine prior release.
  const coincidentTagsOut = await $`git -C ${clone} tag --points-at ${sha}`.text();
  const coincidentTags = coincidentTagsOut
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const ct of coincidentTags) {
    await $`git -C ${clone} tag -d ${ct}`.quiet().nothrow();
  }
  await $`git -C ${clone} checkout -B ${branch} ${sha} --quiet`;

  // The clone only carries refs/heads/$BRANCH locally; seed the other
  // configured branch from origin's tracking ref so semantic-release's
  // branch validator sees both.
  for (const cfg of ["main", "develop"]) {
    if (cfg === branch) continue;
    const refSha = await $`git -C ${clone} rev-parse --verify -q refs/remotes/origin/${cfg}`
      .nothrow()
      .quiet();
    if (refSha.exitCode === 0) {
      await $`git -C ${clone} update-ref refs/heads/${cfg} ${refSha.text().trim()}`;
    }
  }

  // semantic-release's notes reader returns channels=[null] for any tag
  // missing an annotation, and the prerelease filter drops those tags
  // entirely — walking lastRelease back far enough to drag unrelated commits
  // into the changelog. Seed a channel note for every reachable tag that
  // lacks one, inferring the channel from the tag name.
  const mergedTagsOut = await $`git -C ${clone} tag --merged HEAD --sort=v:refname`.text();
  const mergedTags = mergedTagsOut.split("\n").filter((t) => t && t !== tag);
  for (const prevTag of mergedTags) {
    const noteCheck = await $`git -C ${clone} notes --ref semantic-release show ${prevTag}`
      .nothrow()
      .quiet();
    if (noteCheck.exitCode === 0) continue;
    const channel = prevTag.includes("-beta.")
      ? "beta"
      : prevTag.includes("-alpha.")
        ? "alpha"
        : "latest";
    const payload = JSON.stringify({ channels: [channel] });
    await $`git -C ${clone} notes --ref semantic-release add -f -m ${payload} ${prevTag}^{commit}`.quiet();
  }

  // Apply the current release config to the historical checkout, so the notes
  // come out in the right shape regardless of what release config shipped at the tag.
  const clonePkgPath = path.join(clone, "apps/cli/package.json");
  const clonePkg = JSON.parse(await readFile(clonePkgPath, "utf8"));
  clonePkg.release = rootPkg.release;
  await writeFile(clonePkgPath, `${JSON.stringify(clonePkg, null, 2)}\n`);
  await copyLocalReleasePlugins(clone);

  // semantic-release exits with "behind remote" whenever the remote tip
  // differs from HEAD, which it always does when backfilling an old tag. Use
  // git's insteadOf to redirect the GitHub URL to the local clone for this
  // run, while semantic-release still renders commit/PR links against the real URL.
  await $`git -C ${clone} config --local url.file://${clone}.insteadOf ${repoUrl}`;

  console.error(`==> Re-staged on ${branch} @ ${sha} (without tag ${tag})`);
  console.error(`==> Running semantic-release --dry-run`);

  // env-ci detects the branch from GITHUB_REF (and friends) even with `noCi:
  // true`, which only bypasses the "not in CI" guard. That can name a branch
  // other than the one the clone's HEAD actually points at, so strip the
  // GitHub Actions detection vars and let env-ci read HEAD directly.
  const childEnv = { ...process.env };
  for (const key of [
    "GITHUB_ACTIONS",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_HEAD_REF",
    "GITHUB_BASE_REF",
    "GITHUB_EVENT_NAME",
    "CI",
  ]) {
    delete childEnv[key];
  }

  const result = await semanticRelease(
    { dryRun: true, noCi: true, repositoryUrl: repoUrl },
    {
      cwd: path.join(clone, "apps/cli"),
      env: childEnv,
      stdout: process.stderr,
      stderr: process.stderr,
    },
  );

  if (!result || !result.nextRelease) {
    console.error(`semantic-release did not compute a next release for ${tag}`);
    process.exit(1);
  }

  const expected = tag.replace(/^v/, "");
  if (result.nextRelease.version !== expected) {
    console.error(
      `semantic-release computed v${result.nextRelease.version} but expected ${tag}; ` +
        `check channel notes and release config`,
    );
    process.exit(1);
  }

  const notes = result.nextRelease.notes ?? "";

  if (apply) {
    const notesFile = path.join(work, "notes.md");
    await writeFile(notesFile, notes);
    console.error(`==> Updating GitHub Release body for ${tag}`);
    await $`gh release edit ${tag} --notes-file ${notesFile}`;
  } else {
    process.stdout.write(notes);
    if (!notes.endsWith("\n")) process.stdout.write("\n");
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

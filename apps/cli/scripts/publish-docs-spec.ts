// oxlint-disable effecttsgo/global-console, effecttsgo/node-builtin-import -- this publishing script is an imperative host-tool boundary.
/**
 * Publishes the generated CLI reference to the docs site by opening a PR
 * against supabase/supabase, replacing the Go `tools/bumpdoc` that was deleted
 * in the monorepo merge (71b543255). The reference has not been republished
 * since, so the published spec is frozen at 2.98.2.
 *
 * Reads the spec on stdin so it composes with the generator exactly the way the
 * Go release job did:
 *
 *   bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version>
 *
 * Like `bumpdoc`, this is a no-op when the spec is already published and no PR
 * is missing: it prints "already up to date" and exits 0. A branch whose spec
 * is ahead of base still gets its PR ensured, so a run that pushed but failed
 * to open the PR is repaired by the next release. Any real failure exits
 * non-zero.
 */
import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { parse } from "yaml";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/supabase" },
    // Path of the spec inside the docs repo, as the Go job passed it.
    "spec-path": { type: "string", default: "apps/docs/spec/cli_v1_commands.yaml" },
    branch: { type: "string", default: "cli/ref-doc" },
    base: { type: "string", default: "master" },
    "dry-run": { type: "boolean", default: false },
  },
});

const versionArgument = values.version;
if (!versionArgument) {
  console.error(
    "Usage: bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--repo <owner/repo>] [--spec-path <path>] [--branch <name>] [--base <branch>] [--dry-run]",
  );
  process.exit(1);
}
const version = versionArgument.startsWith("v") ? versionArgument.slice(1) : versionArgument;

const repo = values.repo!;
const specPath = values["spec-path"]!;
const branch = values.branch!;
const base = values.base!;
const dryRun = values["dry-run"]!;

const spec = await Bun.stdin.text();
if (spec.trim().length === 0) {
  console.error("Refusing to publish an empty spec: nothing was piped in on stdin.");
  process.exit(1);
}

let parsed: { clispec?: unknown; info?: { version?: unknown }; commands?: unknown };
try {
  parsed = parse(spec);
} catch (error) {
  console.error(`Refusing to publish: stdin is not valid YAML (${String(error)}).`);
  process.exit(1);
}
if (parsed?.clispec !== "001") {
  console.error(
    `Refusing to publish: expected clispec "001", got ${JSON.stringify(parsed?.clispec)}.`,
  );
  process.exit(1);
}
if (parsed.info?.version !== version) {
  console.error(
    `Refusing to publish: the spec's version ${JSON.stringify(parsed.info?.version)} does not match --version ${version}.`,
  );
  process.exit(1);
}
const commands = parsed.commands;
if (!Array.isArray(commands) || commands.length < 144) {
  console.error(
    `Refusing to publish: the spec has ${Array.isArray(commands) ? commands.length : 0} commands, expected at least 144.`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(`Would publish ${spec.length} bytes to ${repo}:${specPath} on branch ${branch}`);
  process.exit(0);
}

// `--depth 1` is enough: when `cli/ref-doc` already exists its tip is fetched
// and the new spec lands as one commit on top, so commits pushed onto an open
// PR (sidebar fixes) survive later releases; otherwise the branch starts from
// base.
const tmpDir = await mkdtemp(path.join(tmpdir(), "supabase-docs-"));
try {
  await $`git clone --quiet --depth 1 --branch ${base} https://github.com/${repo}.git ${tmpDir}`;

  const remoteBranch = await $`git -C ${tmpDir} fetch --quiet --depth 1 origin ${branch}`
    .nothrow()
    .quiet();
  if (remoteBranch.exitCode === 0) {
    await $`git -C ${tmpDir} checkout --quiet -B ${branch} FETCH_HEAD`;
  } else {
    await $`git -C ${tmpDir} checkout --quiet -B ${branch}`;
  }

  const target = path.join(tmpDir, specPath);
  await writeFile(target, spec);
  const prettier = path.resolve(import.meta.dir, "../node_modules/.bin/prettier");
  await $`${prettier} --no-config --single-quote --print-width 100 --log-level warn --write ${target}`;

  const message = "chore: update cli reference doc";
  await $`git -C ${tmpDir} add ${specPath}`;
  const unchanged = await $`git -C ${tmpDir} diff --quiet --cached -- ${specPath}`
    .nothrow()
    .quiet();
  if (unchanged.exitCode === 0) {
    console.log(
      remoteBranch.exitCode === 0
        ? `${specPath} is already up to date on ${branch}`
        : `${specPath} is already up to date in ${repo}`,
    );
  } else {
    await $`git -C ${tmpDir} -c ${"user.name=github-actions[bot]"} -c ${"user.email=41898282+github-actions[bot]@users.noreply.github.com"} commit --quiet -m ${message}`;
    await $`git -C ${tmpDir} push --quiet origin ${branch}`;
    console.log(`Pushed ${branch} to ${repo}`);
  }

  const unpublished = await $`git -C ${tmpDir} diff --quiet origin/${base} HEAD -- ${specPath}`
    .nothrow()
    .quiet();
  if (unpublished.exitCode === 1) {
    const existing =
      await $`gh pr list --repo ${repo} --head ${branch} --base ${base} --state open --json number,headRepositoryOwner`
        .cwd(tmpDir)
        .text();
    const openPulls: Array<{ headRepositoryOwner?: { login?: string } }> = JSON.parse(existing);
    const ownPulls = openPulls.filter(
      (pull) =>
        pull.headRepositoryOwner?.login?.toLowerCase() === repo.split("/")[0]?.toLowerCase(),
    );
    if (ownPulls.length > 0) {
      console.log(`Reusing the open PR for ${branch}`);
    } else {
      const body = [
        "Updates the CLI reference from the supabase/cli release workflow.",
        "",
        "Generated by `scripts/generate-docs-spec.ts` in supabase/cli — edit the",
        "command tree or the content under `apps/cli/docs/` there rather than this",
        "file.",
        "",
        "New commands also need an entry in `apps/docs/spec/common-cli-sections.json` —",
        "without one a command's page is silently dropped from the docs site.",
        "Sections fixes can be committed directly onto this branch — later releases",
        "add commits on top instead of rewriting it.",
      ].join("\n");
      await $`gh pr create --repo ${repo} --title ${message} --body ${body} --base ${base} --head ${branch}`.cwd(
        tmpDir,
      );
      console.log(`Opened a pull request against ${repo}`);
    }
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

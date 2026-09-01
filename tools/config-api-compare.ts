/**
 * Diffs `@supabase/config`'s compiled `.d.ts` surface between a PR's base and
 * head commits — a per-PR type-surface signal with zero committed artifacts
 * (CLI-2234; replaces the checked-in `packages/config/api-report/` mirror).
 *
 * Usage:
 *   bun tools/config-api-compare.ts [--base <ref>]
 *
 * Base ref resolution, in order: `--base`, then `GITHUB_BASE_REF` (prefixed
 * `origin/`), then `origin/develop`. Resolves `git merge-base HEAD <base>`,
 * fetching `origin/<branch>` at depth 1 first when the ref is missing locally
 * (a shallow CI clone only has the PR's own commits). If HEAD's own checkout
 * is also shallow, a depth-1 base fetch still can't produce a common
 * ancestor — the tool then unshallows (or deepens) the checkout and retries
 * once more before giving up and skipping the compare.
 *
 * Emits declarations twice with the same compiler settings — head from
 * `packages/config/src` directly, base from a `git archive` of the
 * merge-base extracted into `packages/config/.api-compare/base/` (so
 * dependency resolution walks up to `packages/config/node_modules` using the
 * CURRENT install, no second `pnpm install` needed) — then diffs the two
 * `.d.ts` trees.
 *
 * Advisory at PR time (a base-vs-head diff has no acceptance artifact to
 * gate on); the hard release-time gate is tracked under CLI-2233.
 *
 * Exit codes: 0 identical (or compare skipped), 1 surface differs, 2 tool
 * failure.
 */

import { appendFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "config");
const tscBinPath = path.join(packageRoot, "node_modules", ".bin", "tsc");

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function requireBinaries(names: readonly string[]): void {
  const missing = names.filter((name) => Bun.which(name) === null);
  if (missing.length > 0) {
    throw new Error(`this tool requires ${missing.join(", ")} on PATH.`);
  }
}

/** `--base` wins; else `GITHUB_BASE_REF` (a PR's base branch name, no remote prefix) under `origin/`; else `origin/develop`. */
function resolveBaseRef(cliBase: string | undefined): string {
  if (cliBase) {
    return cliBase;
  }
  const githubBaseRef = process.env.GITHUB_BASE_REF;
  if (githubBaseRef) {
    return `origin/${githubBaseRef}`;
  }
  return "origin/develop";
}

type MergeBaseResolution =
  | { readonly kind: "resolved"; readonly sha: string }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * Resolves `git merge-base HEAD <baseRef>`. A shallow CI checkout only has
 * the PR's own commits, so `<baseRef>` can be locally unresolvable — when
 * it's an `origin/<branch>` ref, fetch that branch at depth 1 and retry
 * before giving up.
 *
 * A depth-1 base fetch only helps when the base ref itself was simply never
 * fetched; it cannot produce a common ancestor when HEAD's own checkout is
 * shallow too (the `check` job's default `actions/checkout` depth), since
 * neither side's shallow history reaches the other's. In that case, unshallow
 * (or deepen, if `--unshallow` errors because the checkout is already
 * complete) the repository, refetch the base ref in full, and retry once
 * more. If a merge-base still can't be resolved, this is an advisory check —
 * skip the compare instead of failing the tool.
 *
 * A non-`origin/` ref (e.g. an explicit `--base <sha>`) that doesn't resolve
 * locally is a caller error, not something this tool can fetch its way out
 * of.
 */
async function resolveMergeBase(baseRef: string): Promise<MergeBaseResolution> {
  const attempt = await runGit(["merge-base", "HEAD", baseRef], repoRoot);
  if (attempt.exitCode === 0) {
    return { kind: "resolved", sha: attempt.stdout.trim() };
  }

  if (!baseRef.startsWith("origin/")) {
    throw new Error(
      `could not resolve base ref "${baseRef}" (git merge-base: ${attempt.stderr.trim()}). Pass a ` +
        `ref that already exists locally, or one under "origin/" so it can be fetched.`,
    );
  }

  const branchName = baseRef.slice("origin/".length);
  console.warn(
    `[config-api-compare] ${baseRef} did not resolve locally (${attempt.stderr.trim()}); fetching ` +
      `origin/${branchName} at depth 1...`,
  );
  const fetch = await runGit(
    ["fetch", "--depth=1", "origin", `+${branchName}:refs/remotes/origin/${branchName}`],
    repoRoot,
  );
  if (fetch.exitCode !== 0) {
    throw new Error(`git fetch --depth=1 origin ${branchName} failed: ${fetch.stderr.trim()}`);
  }

  const retry = await runGit(["merge-base", "HEAD", baseRef], repoRoot);
  if (retry.exitCode === 0) {
    return { kind: "resolved", sha: retry.stdout.trim() };
  }

  const isShallow = await runGit(["rev-parse", "--is-shallow-repository"], repoRoot);
  if (isShallow.stdout.trim() !== "true") {
    throw new Error(
      `could not resolve base ref "${baseRef}" even after fetching origin/${branchName}: ` +
        retry.stderr.trim(),
    );
  }

  console.warn(
    `[config-api-compare] HEAD's own checkout is shallow, so a depth-1 ${baseRef} fetch can't ` +
      "produce a common ancestor; unshallowing before retrying merge-base...",
  );
  const unshallow = await runGit(["fetch", "--unshallow", "origin", branchName], repoRoot);
  if (unshallow.exitCode !== 0) {
    console.warn(
      `[config-api-compare] git fetch --unshallow failed (${unshallow.stderr.trim()}); falling ` +
        "back to git fetch --deepen=100000...",
    );
    const deepen = await runGit(["fetch", "--deepen=100000", "origin"], repoRoot);
    if (deepen.exitCode !== 0) {
      return {
        kind: "skip",
        reason:
          `could not unshallow (${unshallow.stderr.trim()}) or deepen ` +
          `(${deepen.stderr.trim()}) the checkout to resolve a merge-base against ${baseRef}.`,
      };
    }
  }

  const fullFetch = await runGit(
    ["fetch", "origin", `+${branchName}:refs/remotes/origin/${branchName}`],
    repoRoot,
  );
  if (fullFetch.exitCode !== 0) {
    return {
      kind: "skip",
      reason: `could not fully fetch origin/${branchName} after unshallowing: ${fullFetch.stderr.trim()}.`,
    };
  }

  const finalRetry = await runGit(["merge-base", "HEAD", baseRef], repoRoot);
  if (finalRetry.exitCode === 0) {
    return { kind: "resolved", sha: finalRetry.stdout.trim() };
  }

  return {
    kind: "skip",
    reason:
      `could not resolve a merge-base between HEAD and ${baseRef} even after unshallowing ` +
      `(git merge-base: ${finalRetry.stderr.trim()}).`,
  };
}

async function shortSha(rev: string): Promise<string> {
  const result = await runGit(["rev-parse", "--short", rev], repoRoot);
  return result.exitCode === 0 ? result.stdout.trim() : rev;
}

async function pathExistsAtRev(rev: string, relativePath: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "cat-file", "-e", `${rev}:${relativePath}`], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

/**
 * `git archive <rev> <relativePaths>` piped straight into `tar -x`, stripping
 * the shared `packages/config/` prefix (2 path components) so the extracted
 * tree lands directly under `destDir`.
 */
async function archiveAndExtract(
  rev: string,
  relativePaths: readonly string[],
  destDir: string,
): Promise<void> {
  const archiveProc = Bun.spawn(["git", "archive", rev, ...relativePaths], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const tarProc = Bun.spawn(["tar", "-x", "-C", destDir, "--strip-components=2"], {
    stdin: archiveProc.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [archiveExitCode, tarExitCode, archiveStderr, tarStderr] = await Promise.all([
    archiveProc.exited,
    tarProc.exited,
    new Response(archiveProc.stderr).text(),
    new Response(tarProc.stderr).text(),
  ]);
  if (archiveExitCode !== 0) {
    throw new Error(
      `git archive ${rev} ${relativePaths.join(" ")} failed: ${archiveStderr.trim()}`,
    );
  }
  if (tarExitCode !== 0) {
    throw new Error(`tar extraction into ${destDir} failed: ${tarStderr.trim()}`);
  }
}

/**
 * Materializes the base revision's `packages/config/src` (plus its
 * declaration-emit config) under `baseExtractDir`, INSIDE `packages/config`,
 * so tsc's node_modules walk from there reaches `packages/config/node_modules`
 * with the CURRENT install — no second `pnpm install` needed.
 *
 * `tsconfig.build.json` is always the HEAD copy (tooling, not part of the
 * compared surface, and required so `tsconfig.declarations.json`'s own
 * `"extends": "./tsconfig.build.json"` resolves inside the extracted tree).
 * `tsconfig.declarations.json` is the base revision's own copy when it has
 * one; a merge-base that predates this file (e.g. still on the checked-in
 * `api-report/` mirror, or older) falls back to the HEAD copy for the emit
 * settings.
 */
async function extractBaseTree(mergeBase: string, baseExtractDir: string): Promise<void> {
  await mkdir(baseExtractDir, { recursive: true });

  const srcRelativePath = "packages/config/src";
  const declarationsRelativePath = "packages/config/tsconfig.declarations.json";

  if (!(await pathExistsAtRev(mergeBase, srcRelativePath))) {
    throw new Error(`base revision ${mergeBase} has no ${srcRelativePath} — cannot compare`);
  }

  const hasDeclarationsConfig = await pathExistsAtRev(mergeBase, declarationsRelativePath);
  const archivePaths = hasDeclarationsConfig
    ? [srcRelativePath, declarationsRelativePath]
    : [srcRelativePath];
  await archiveAndExtract(mergeBase, archivePaths, baseExtractDir);

  await cp(
    path.join(packageRoot, "tsconfig.build.json"),
    path.join(baseExtractDir, "tsconfig.build.json"),
  );
  if (!hasDeclarationsConfig) {
    console.warn(
      `[config-api-compare] base revision ${await shortSha(mergeBase)} predates ` +
        "tsconfig.declarations.json — using the HEAD copy for emit settings.",
    );
    await cp(
      path.join(packageRoot, "tsconfig.declarations.json"),
      path.join(baseExtractDir, "tsconfig.declarations.json"),
    );
  }
}

interface EmitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly fileCount: number;
}

async function countDeclarationFiles(dir: string): Promise<number> {
  const glob = new Bun.Glob("**/*.d.ts");
  let count = 0;
  for await (const _relativePath of glob.scan({ cwd: dir })) {
    count++;
  }
  return count;
}

async function listDeclarationFiles(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.d.ts");
  const relativePaths: string[] = [];
  for await (const relativePath of glob.scan({ cwd: dir })) {
    relativePaths.push(relativePath);
  }
  return relativePaths.sort();
}

/**
 * Spawns this package's own `node_modules/.bin/tsc` directly rather than
 * `pnpm exec tsc` (the same corepack-avoidance lesson as the old
 * `api-report.unit.test.ts`: a bun-shimmed `PATH` can route `pnpm`'s launcher
 * through Bun's `node:sqlite`-less Node-compat layer). `noEmitOnError`
 * defaults to false, so declarations are emitted even when the base tree's
 * old source doesn't type-check cleanly against the current install's
 * (newer) dependencies — a genuinely empty output is the only signal treated
 * as a hard failure by the caller.
 */
async function emitDeclarations(
  projectPath: string,
  outDir: string,
  cwd: string,
): Promise<EmitResult> {
  const proc = Bun.spawn([tscBinPath, "-p", projectPath, "--outDir", outDir], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const fileCount = await countDeclarationFiles(outDir);
  return { exitCode, stdout, stderr, fileCount };
}

async function unifiedDiff(
  oldPath: string,
  newPath: string,
  oldLabel: string,
  newLabel: string,
): Promise<string> {
  const proc = Bun.spawn(["diff", "-u", "-L", oldLabel, "-L", newLabel, oldPath, newPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return stdout;
}

interface FileEntry {
  readonly status: "added" | "removed" | "changed";
  readonly path: string;
  readonly diff: string;
}

interface CompareResult {
  readonly identical: boolean;
  readonly entries: readonly FileEntry[];
}

/** Diffs the two emitted `.d.ts` trees (`**\/*.d.ts` only — the glob itself never matches `.d.ts.map`). */
async function diffDeclarationTrees(headDir: string, baseDir: string): Promise<CompareResult> {
  const [headFiles, baseFiles] = await Promise.all([
    listDeclarationFiles(headDir),
    listDeclarationFiles(baseDir),
  ]);
  const headSet = new Set(headFiles);
  const baseSet = new Set(baseFiles);

  const entries: FileEntry[] = [];

  for (const relativePath of headFiles) {
    if (!baseSet.has(relativePath)) {
      entries.push({
        status: "added",
        path: relativePath,
        diff: await unifiedDiff(
          "/dev/null",
          path.join(headDir, relativePath),
          "/dev/null",
          `head/${relativePath}`,
        ),
      });
      continue;
    }

    const [headContent, baseContent] = await Promise.all([
      readFile(path.join(headDir, relativePath), "utf8"),
      readFile(path.join(baseDir, relativePath), "utf8"),
    ]);
    if (headContent !== baseContent) {
      entries.push({
        status: "changed",
        path: relativePath,
        diff: await unifiedDiff(
          path.join(baseDir, relativePath),
          path.join(headDir, relativePath),
          `base/${relativePath}`,
          `head/${relativePath}`,
        ),
      });
    }
  }

  for (const relativePath of baseFiles) {
    if (!headSet.has(relativePath)) {
      entries.push({
        status: "removed",
        path: relativePath,
        diff: await unifiedDiff(
          path.join(baseDir, relativePath),
          "/dev/null",
          `base/${relativePath}`,
          "/dev/null",
        ),
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { identical: entries.length === 0, entries };
}

function countByStatus(entries: readonly FileEntry[], status: FileEntry["status"]): number {
  return entries.filter((entry) => entry.status === status).length;
}

function renderTextReport(baseLabel: string, headLabel: string, result: CompareResult): string {
  const lines: string[] = [`Config type-surface diff: ${baseLabel} -> ${headLabel}`, ""];
  if (result.identical) {
    lines.push("No type-surface differences.");
    return lines.join("\n");
  }

  lines.push(
    `Added: ${countByStatus(result.entries, "added")}, ` +
      `Removed: ${countByStatus(result.entries, "removed")}, ` +
      `Changed: ${countByStatus(result.entries, "changed")}`,
    "",
  );
  for (const entry of result.entries) {
    lines.push(`--- ${entry.status} ${entry.path} ---`, entry.diff.trimEnd(), "");
  }
  return lines.join("\n");
}

function renderMarkdownSummary(
  baseLabel: string,
  headLabel: string,
  result: CompareResult,
): string {
  const lines: string[] = [
    "## Config type-surface diff (advisory)",
    "",
    `Comparing \`${baseLabel}\` against \`${headLabel}\` for \`@supabase/config\`'s compiled ` +
      "declaration surface. Advisory only — see CLI-2233 for the planned release-time hard gate.",
    "",
  ];
  if (result.identical) {
    lines.push("No type-surface differences.");
    return lines.join("\n");
  }

  lines.push(
    `**${countByStatus(result.entries, "added")} added, ` +
      `${countByStatus(result.entries, "removed")} removed, ` +
      `${countByStatus(result.entries, "changed")} changed**`,
    "",
  );
  for (const entry of result.entries) {
    lines.push(
      `<details><summary>${entry.status}: <code>${entry.path}</code></summary>`,
      "",
      "```diff",
      entry.diff.trimEnd(),
      "```",
      "",
      "</details>",
      "",
    );
  }
  return lines.join("\n");
}

function renderShallowHistorySkippedSummary(
  baseRef: string,
  headLabel: string,
  reason: string,
): string {
  return [
    "## Config type-surface diff (advisory)",
    "",
    `⚠️ Compare skipped (shallow history): could not resolve a merge-base between \`${headLabel}\` ` +
      `and \`${baseRef}\`: ${reason}`,
  ].join("\n");
}

function renderSkippedSummary(baseLabel: string, headLabel: string, baseEmit: EmitResult): string {
  return [
    "## Config type-surface diff (advisory)",
    "",
    `⚠️ Compare skipped: the base revision (\`${baseLabel}\`) declaration emit produced zero ` +
      `\`.d.ts\` files against \`${headLabel}\` (tsc exit ${baseEmit.exitCode}). Old source failing ` +
      'to emit against the current install\'s dependencies is treated as "nothing to compare" ' +
      "rather than a false positive.",
  ].join("\n");
}

async function writeStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

async function main(): Promise<number> {
  requireBinaries(["git", "tar", "diff"]);

  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const baseRef = resolveBaseRef(values.base);
  const mergeBaseResolution = await resolveMergeBase(baseRef);
  if (mergeBaseResolution.kind === "skip") {
    const headLabel = await shortSha("HEAD");
    console.warn(`[config-api-compare] WARNING: ${mergeBaseResolution.reason}`);
    await writeStepSummary(
      renderShallowHistorySkippedSummary(baseRef, headLabel, mergeBaseResolution.reason),
    );
    return 0;
  }
  const mergeBase = mergeBaseResolution.sha;
  const [baseLabel, headLabel] = await Promise.all([shortSha(mergeBase), shortSha("HEAD")]);
  console.log(
    `[config-api-compare] comparing merge-base ${baseLabel} (of ${baseRef}) against HEAD ${headLabel}...`,
  );

  const compareDir = path.join(packageRoot, ".api-compare");
  const baseExtractDir = path.join(compareDir, "base");
  const headOutDir = await mkdtemp(path.join(tmpdir(), "supabase-config-api-compare-head-"));
  const baseOutDir = await mkdtemp(path.join(tmpdir(), "supabase-config-api-compare-base-"));

  try {
    await rm(compareDir, { recursive: true, force: true });

    console.log("[config-api-compare] emitting head declarations...");
    const headEmit = await emitDeclarations(
      path.join(packageRoot, "tsconfig.declarations.json"),
      headOutDir,
      packageRoot,
    );
    if (headEmit.fileCount === 0) {
      throw new Error(
        `head declaration emit produced zero .d.ts files (tsc exit ${headEmit.exitCode}):\n` +
          `${headEmit.stdout}\n${headEmit.stderr}`,
      );
    }

    console.log("[config-api-compare] extracting and emitting base declarations...");
    await extractBaseTree(mergeBase, baseExtractDir);
    const baseEmit = await emitDeclarations(
      path.join(baseExtractDir, "tsconfig.declarations.json"),
      baseOutDir,
      baseExtractDir,
    );
    if (baseEmit.fileCount === 0) {
      console.warn(
        `[config-api-compare] WARNING: base declaration emit produced zero .d.ts files (tsc exit ` +
          `${baseEmit.exitCode}) — skipping the compare rather than reporting a false surface diff.\n` +
          baseEmit.stderr,
      );
      await writeStepSummary(renderSkippedSummary(baseLabel, headLabel, baseEmit));
      return 0;
    }

    const result = await diffDeclarationTrees(headOutDir, baseOutDir);
    console.log(renderTextReport(baseLabel, headLabel, result));
    await writeStepSummary(renderMarkdownSummary(baseLabel, headLabel, result));

    return result.identical ? 0 : 1;
  } finally {
    await Promise.all([
      rm(compareDir, { recursive: true, force: true }),
      rm(headOutDir, { recursive: true, force: true }),
      rm(baseOutDir, { recursive: true, force: true }),
    ]);
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`[config-api-compare] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

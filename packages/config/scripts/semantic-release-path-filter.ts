/**
 * An in-repo replacement for the unmaintained `semantic-release-monorepo`
 * wrapper (CLI-2233). This repo runs `@supabase/config`'s release from the
 * monorepo root's git history: without filtering, a `fix:` commit anywhere
 * in `apps/cli` (or any other workspace) would be analyzed as if it touched
 * `packages/config/` and falsely trigger a config release.
 *
 * {@link filterCommitsToPackage} narrows `context.commits` down to the ones
 * whose diff actually touches a path under {@link PACKAGE_PATH_PREFIX};
 * {@link analyzeCommits}/{@link generateNotes} apply that filter and then
 * delegate to the real `@semantic-release/commit-analyzer` and
 * `@semantic-release/release-notes-generator` plugins, so this package still
 * gets the standard Angular commit-analysis and changelog rendering — just
 * scoped to its own history.
 */

import process from "node:process";

import type { AnalyzeCommitsContext, GenerateNotesContext } from "semantic-release";

/**
 * `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator`
 * ship no `.d.ts` of their own (only `semantic-release` itself does), and
 * TypeScript refuses a `declare module` augmentation for a specifier that
 * already resolves to a real, untyped file (TS2665) from anywhere but a
 * genuinely global, import/export-free `.d.ts` — not an option for a
 * single-file plugin. `require()`'s return type is an explicit `any` (not an
 * implicit one, so this doesn't trip `noImplicitAny`), and its result is
 * narrowed into these two locally declared structural interfaces via typed
 * `const` bindings immediately below — no `any`/`as` leaks past that point.
 */
type PluginConfig = Record<string, unknown>;

interface CommitAnalyzerPlugin {
  readonly analyzeCommits: (
    pluginConfig: PluginConfig,
    context: AnalyzeCommitsContext,
  ) => Promise<string | null>;
}

interface ReleaseNotesGeneratorPlugin {
  readonly generateNotes: (
    pluginConfig: PluginConfig,
    context: GenerateNotesContext,
  ) => Promise<string>;
}

const commitAnalyzer: CommitAnalyzerPlugin = require("@semantic-release/commit-analyzer");
const releaseNotesGenerator: ReleaseNotesGeneratorPlugin = require("@semantic-release/release-notes-generator");

export const PACKAGE_PATH_PREFIX = "packages/config/";

/**
 * Resolves which of `commits` touch a path under {@link PACKAGE_PATH_PREFIX},
 * using ONE batched `git diff-tree --stdin -r --root --name-only` subprocess rather
 * than one per commit — the first release analyzes the repo's entire
 * history (thousands of commits).
 *
 * Output format (verified empirically against this repo, including a merge
 * commit): for each input hash that touches at least one file, `git
 * diff-tree` echoes that hash on its own line, followed by that commit's
 * changed paths (repo-root-relative, one per line), with no blank-line
 * separator before the next hash. A merge commit prints nothing at all here
 * (no hash line, no file lines) because `-m` is deliberately omitted: this
 * trunk is squash-merged, so a merge commit carries no analyzable change of
 * its own, and dropping it out of the result is intended, not a parsing gap.
 * A root commit would print nothing too — `--root` closes that gap by
 * diffing it against the empty tree (merge behavior is unaffected).
 */
export async function filterCommitsToPackage<T extends { hash: string }>(
  commits: readonly T[],
  cwd: string,
): Promise<T[]> {
  if (commits.length === 0) {
    return [];
  }

  const hashes = commits.map((commit) => commit.hash);
  const knownHashes = new Set(hashes);

  const proc = Bun.spawn(["git", "diff-tree", "--stdin", "-r", "--root", "--name-only"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.stdin.write(`${hashes.join("\n")}\n`);
  await proc.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git diff-tree --stdin failed with exit code ${exitCode}: ${stderr.trim()}`);
  }

  const touchedHashes = new Set<string>();
  let currentHash: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    if (knownHashes.has(line)) {
      currentHash = line;
      continue;
    }
    if (currentHash !== null && line.startsWith(PACKAGE_PATH_PREFIX)) {
      touchedHashes.add(currentHash);
    }
  }

  return commits.filter((commit) => touchedHashes.has(commit.hash));
}

export async function analyzeCommits(
  pluginConfig: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<string | null> {
  const filtered = await filterCommitsToPackage(context.commits, context.cwd ?? process.cwd());
  context.logger.log(
    `Analyzing ${filtered.length} of ${context.commits.length} commits touching ${PACKAGE_PATH_PREFIX}`,
  );
  return commitAnalyzer.analyzeCommits(pluginConfig, { ...context, commits: filtered });
}

export async function generateNotes(
  pluginConfig: PluginConfig,
  context: GenerateNotesContext,
): Promise<string> {
  const filtered = await filterCommitsToPackage(context.commits, context.cwd ?? process.cwd());
  context.logger.log(
    `Analyzing ${filtered.length} of ${context.commits.length} commits touching ${PACKAGE_PATH_PREFIX}`,
  );
  return releaseNotesGenerator.generateNotes(pluginConfig, { ...context, commits: filtered });
}

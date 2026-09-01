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
 * using ONE batched `git diff-tree --stdin -r --root --name-only -z`
 * subprocess rather than one per commit — the first release analyzes the
 * repo's entire history (thousands of commits).
 *
 * Output format (verified empirically against this repo, including a merge
 * commit): with `-z`, every element — each echoed input hash and each of its
 * changed paths (repo-root-relative) — is NUL-terminated, with no other
 * separators. `-z` matters for correctness, not just parsing convenience:
 * without it, `core.quotePath` (default true) C-quotes any path with
 * non-ASCII or special bytes (`"packages/config/caf\303\251.ts"`), which
 * would silently fail the prefix match and drop a genuinely releasable
 * commit. A merge commit prints nothing at all here (no hash, no paths)
 * because `-m` is deliberately omitted: this trunk is squash-merged, so a
 * merge commit carries no analyzable change of its own, and dropping it out
 * of the result is intended, not a parsing gap. A root commit would print
 * nothing too — `--root` closes that gap by diffing it against the empty
 * tree (merge behavior is unaffected).
 */
export async function filterCommitsToPackage<T extends { hash: string }>(
  commits: readonly T[],
  cwd: string,
): Promise<T[]> {
  if (commits.length === 0) {
    return [];
  }

  const hashes = commits.map((commit) => commit.hash);
  // `git diff-tree --stdin` echoes each commit's FULL object ID, and the
  // header recognition below matches echoed elements against the input set —
  // an abbreviated input hash would never match its own echo, silently
  // dropping that commit's paths (a missed release, not an error). Refuse
  // anything but full OIDs up front. (semantic-release always supplies full
  // hashes; this guards other callers.)
  const invalidHashes = hashes.filter((hash) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash));
  if (invalidHashes.length > 0) {
    throw new Error(
      `filterCommitsToPackage requires full lowercase hex object IDs; got: ${invalidHashes
        .slice(0, 3)
        .join(", ")}${invalidHashes.length > 3 ? ", …" : ""}`,
    );
  }
  const knownHashes = new Set(hashes);

  const proc = Bun.spawn(["git", "diff-tree", "--stdin", "-r", "--root", "--name-only", "-z"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Start draining stdout/stderr before writing stdin: Bun buffers subprocess
  // output eagerly so this can't deadlock today, but the classic full-pipe
  // deadlock (git blocked writing stdout while we're blocked writing stdin)
  // is one runtime port away — don't rely on the buffering behavior.
  const stdoutText = new Response(proc.stdout).text();
  const stderrText = new Response(proc.stderr).text();
  await proc.stdin.write(`${hashes.join("\n")}\n`);
  await proc.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutText, stderrText]);
  if (exitCode !== 0) {
    throw new Error(`git diff-tree --stdin failed with exit code ${exitCode}: ${stderr.trim()}`);
  }

  const touchedHashes = new Set<string>();
  let currentHash: string | null = null;
  for (const element of stdout.split("\0")) {
    if (element.length === 0) {
      continue;
    }
    if (knownHashes.has(element)) {
      currentHash = element;
      continue;
    }
    if (currentHash !== null && element.startsWith(PACKAGE_PATH_PREFIX)) {
      touchedHashes.add(currentHash);
    }
  }

  return commits.filter((commit) => touchedHashes.has(commit.hash));
}

async function withFilteredCommits<C extends AnalyzeCommitsContext | GenerateNotesContext, R>(
  context: C,
  step: string,
  delegate: (filteredContext: C) => Promise<R>,
): Promise<R> {
  const filtered = await filterCommitsToPackage(context.commits, context.cwd ?? process.cwd());
  context.logger.log(
    `${step}: ${filtered.length} of ${context.commits.length} commits touch ${PACKAGE_PATH_PREFIX}`,
  );
  return delegate({ ...context, commits: filtered });
}

export async function analyzeCommits(
  pluginConfig: PluginConfig,
  context: AnalyzeCommitsContext,
): Promise<string | null> {
  return withFilteredCommits(context, "analyzeCommits", (filteredContext) =>
    commitAnalyzer.analyzeCommits(pluginConfig, filteredContext),
  );
}

export async function generateNotes(
  pluginConfig: PluginConfig,
  context: GenerateNotesContext,
): Promise<string> {
  return withFilteredCommits(context, "generateNotes", (filteredContext) =>
    releaseNotesGenerator.generateNotes(pluginConfig, filteredContext),
  );
}

/**
 * An in-repo replacement for the unmaintained `semantic-release-monorepo`
 * wrapper. This repo runs `@supabase/config`'s release from the monorepo
 * root's git history: without filtering, a `fix:` commit anywhere else in the
 * repo would be analyzed as if it touched `packages/config/` and falsely
 * trigger a release.
 *
 * {@link filterCommitsToPackage} narrows `context.commits` to the ones whose
 * diff touches a path under {@link PACKAGE_PATH_PREFIX}; {@link analyzeCommits}/
 * {@link generateNotes} apply that filter and delegate to the real
 * commit-analyzer/release-notes-generator plugins, so this package still gets
 * standard Angular commit analysis, just scoped to its own history.
 */

import process from "node:process";

import type { AnalyzeCommitsContext, GenerateNotesContext } from "semantic-release";

/**
 * `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator`
 * ship no `.d.ts` of their own, and TypeScript refuses a `declare module`
 * augmentation for an already-resolved untyped specifier (TS2665) from anywhere
 * but a global, import/export-free `.d.ts` — not an option here. `require()`'s
 * return is an explicit `any`, narrowed into these two structural interfaces via
 * typed `const` bindings below, so no `any`/`as` leaks past this point.
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
 * Resolves which of `commits` touch a path under {@link PACKAGE_PATH_PREFIX}
 * using one batched `git diff-tree --stdin -r --root --name-only -z`
 * subprocess, since the first release analyzes the repo's entire history. With
 * `-z`, every echoed hash and changed path is NUL-terminated with no other
 * separators, avoiding `core.quotePath`'s C-quoting of non-ASCII paths (which
 * would silently break the prefix match). A merge commit prints nothing since
 * `-m` is omitted for this squash-merged trunk, so it's correctly excluded
 * rather than mis-parsed; `--root` makes a root commit diff against the empty
 * tree instead of also printing nothing.
 */
export async function filterCommitsToPackage<T extends { hash: string }>(
  commits: readonly T[],
  cwd: string,
): Promise<T[]> {
  if (commits.length === 0) {
    return [];
  }

  const hashes = commits.map((commit) => commit.hash);
  // `git diff-tree --stdin` echoes each commit's full object ID, and the header
  // recognition below matches echoed elements against the input set; an
  // abbreviated hash would never match its own echo, silently dropping that
  // commit's paths. Refuse anything but full OIDs up front — semantic-release
  // always supplies them, this guards other callers.
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
  // Starts draining stdout/stderr before writing stdin: Bun buffers subprocess
  // output eagerly so this can't deadlock today, but a future runtime change
  // could reintroduce the classic full-pipe deadlock, so don't rely on that.
  const stdoutText = new Response(proc.stdout).text();
  const stderrText = new Response(proc.stderr).text();
  try {
    await proc.stdin.write(`${hashes.join("\n")}\n`);
    await proc.stdin.end();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) {
      throw error;
    }
  }

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

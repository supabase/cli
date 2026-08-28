/**
 * Shared `.d.ts` tree-diffing machinery for `@supabase/config`'s compiled
 * declaration surface. Used by both the PR-time advisory compare
 * (`tools/config-api-compare.ts`, base vs head commit) and the release-time
 * hard gate (`tools/config-release-gate.ts`, published npm tarball vs freshly
 * built `dist/`).
 */

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function countDeclarationFiles(dir: string): Promise<number> {
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

export interface FileEntry {
  readonly status: "added" | "removed" | "changed";
  readonly path: string;
  readonly diff: string;
}

export interface CompareResult {
  readonly identical: boolean;
  readonly entries: readonly FileEntry[];
}

/** Diffs two emitted `.d.ts` trees (`**\/*.d.ts` only — the glob itself never matches `.d.ts.map`). */
export async function diffDeclarationTrees(
  headDir: string,
  baseDir: string,
): Promise<CompareResult> {
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

export function countByStatus(entries: readonly FileEntry[], status: FileEntry["status"]): number {
  return entries.filter((entry) => entry.status === status).length;
}

/** The `<details>` markdown block for each changed file, shared verbatim by both tools' summaries. */
export function renderDiffDetailsBlocks(entries: readonly FileEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
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
  return lines;
}

export async function writeStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

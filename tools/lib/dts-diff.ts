/**
 * Shared `.d.ts` tree-diffing machinery for `@supabase/config`'s compiled
 * declaration surface. Used by both the PR-time advisory compare
 * (`tools/config-api-compare.ts`, base vs head commit) and the release-time
 * hard gate (`tools/config-release-gate.ts`, published npm tarball vs freshly
 * built `dist/`).
 */

import { Config, Effect, FileSystem, Path, Schema } from "effect";

class DtsDiffError extends Schema.TaggedError<DtsDiffError>()("DtsDiffError", {
  message: Schema.String,
}) {}

const foreignFailure = (cause: unknown) =>
  new DtsDiffError({ message: cause instanceof Error ? cause.message : String(cause) });

/** `Bun.Glob.scan` throws ENOENT on a missing directory; a missing tree means "no declarations", not a tool failure. */
const directoryExists = (fs: FileSystem.FileSystem, dir: string) =>
  fs.stat(dir).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

export const countDeclarationFiles = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* directoryExists(fs, dir))) {
    return 0;
  }
  const glob = new Bun.Glob("**/*.d.ts");
  const relativePaths = yield* Effect.tryPromise({
    try: () => Array.fromAsync(glob.scan({ cwd: dir })),
    catch: foreignFailure,
  });
  return relativePaths.length;
});

const listDeclarationFiles = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  if (!(yield* directoryExists(fs, dir))) {
    return [];
  }
  const glob = new Bun.Glob("**/*.d.ts");
  const relativePaths = yield* Effect.tryPromise({
    try: () => Array.fromAsync(glob.scan({ cwd: dir })),
    catch: foreignFailure,
  });
  return relativePaths.sort();
});

/* `ignoreBOM` keeps a leading BOM, which `readFileString` would strip. */
export const readUtf8 = (fs: FileSystem.FileSystem, filePath: string) =>
  fs
    .readFile(filePath)
    .pipe(Effect.map((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)));

const unifiedDiff = Effect.fnUntraced(function* (
  oldPath: string,
  newPath: string,
  oldLabel: string,
  newLabel: string,
) {
  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn(["diff", "-u", "-L", oldLabel, "-L", newLabel, oldPath, newPath], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: foreignFailure,
  });
  const [, stdout] = yield* Effect.tryPromise({
    try: () => Promise.all([proc.exited, new Response(proc.stdout).text()]),
    catch: foreignFailure,
  });
  return stdout;
});

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
export const diffDeclarationTrees = Effect.fnUntraced(function* (headDir: string, baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [headFiles, baseFiles] = yield* Effect.all(
    [listDeclarationFiles(fs, headDir), listDeclarationFiles(fs, baseDir)],
    { concurrency: "unbounded" },
  );
  const headSet = new Set(headFiles);
  const baseSet = new Set(baseFiles);

  const entries: FileEntry[] = [];

  for (const relativePath of headFiles) {
    if (!baseSet.has(relativePath)) {
      entries.push({
        status: "added",
        path: relativePath,
        diff: yield* unifiedDiff(
          "/dev/null",
          path.join(headDir, relativePath),
          "/dev/null",
          `head/${relativePath}`,
        ),
      });
      continue;
    }

    const [headContent, baseContent] = yield* Effect.all(
      [
        readUtf8(fs, path.join(headDir, relativePath)),
        readUtf8(fs, path.join(baseDir, relativePath)),
      ],
      { concurrency: "unbounded" },
    );
    if (headContent !== baseContent) {
      entries.push({
        status: "changed",
        path: relativePath,
        diff: yield* unifiedDiff(
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
        diff: yield* unifiedDiff(
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
});

export function countByStatus(entries: readonly FileEntry[], status: FileEntry["status"]): number {
  return entries.filter((entry) => entry.status === status).length;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A fence long enough that no backtick run inside `content` can close it — the diffed `.d.ts`
 * text is untrusted, and a JSDoc `@example` with its own fenced block would otherwise break out
 * and render as live markdown in the approver's step summary.
 */
function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Per-file cap; past this, a diff stops being reviewable inline anyway. */
const MAX_RENDERED_DIFF_LENGTH = 20_000;

/**
 * Aggregate cap across all rendered blocks — GITHUB_STEP_SUMMARY rejects uploads past 1024 KiB
 * (dropping the whole summary, losing the approver's evidence), and the per-file cap alone doesn't
 * bound how many capped files there are. Headroom is left for the surrounding summary text.
 */
const MAX_RENDERED_TOTAL_LENGTH = 800_000;

/** The `<details>` markdown block for each changed file, shared verbatim by both tools' summaries. */
export function renderDiffDetailsBlocks(entries: readonly FileEntry[]): string[] {
  const lines: string[] = [];
  let renderedTotal = 0;
  for (const [index, entry] of entries.entries()) {
    let diff = entry.diff.trimEnd();
    if (diff.length > MAX_RENDERED_DIFF_LENGTH) {
      diff =
        `${diff.slice(0, MAX_RENDERED_DIFF_LENGTH)}\n` +
        `… diff truncated (${diff.length} chars total) — see the job log for the full diff`;
    }
    if (renderedTotal + diff.length > MAX_RENDERED_TOTAL_LENGTH) {
      lines.push(
        `⚠️ **${entries.length - index} more changed file(s) omitted — the rendered diff exceeds ` +
          "the step-summary size limit. See the job log for the full diff.**",
        "",
      );
      break;
    }
    renderedTotal += diff.length;
    const fence = fenceFor(diff);
    lines.push(
      `<details><summary>${entry.status}: <code>${escapeHtml(entry.path)}</code></summary>`,
      "",
      `${fence}diff`,
      diff,
      fence,
      "",
      "</details>",
      "",
    );
  }
  return lines;
}

export const writeStepSummary = Effect.fnUntraced(function* (markdown: string) {
  const summaryPath = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.withDefault(""));
  if (!summaryPath) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(summaryPath, `${markdown}\n`, { flag: "a" });
});

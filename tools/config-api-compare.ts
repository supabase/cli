/**
 * Diffs `@supabase/config`'s compiled `.d.ts` surface between a PR's base and head commits.
 *
 * Usage:
 *   bun tools/config-api-compare.ts [--base <ref>]
 *
 * Base ref resolution, in order: `--base`, then `GITHUB_BASE_REF` under `origin/`, then
 * `origin/develop`. Resolves `git merge-base HEAD <base>`, fetching a missing base ref at depth 1
 * first; if HEAD's own checkout is also shallow, unshallows (or deepens) and retries once before
 * skipping the compare.
 *
 * Emits declarations twice with the same compiler settings — head from `packages/config/src`
 * directly, base from a `git archive` of the merge-base extracted under `packages/config` (so
 * dependency resolution reuses the current install) — then diffs the two `.d.ts` trees.
 *
 * Advisory only; the hard release-time gate is `tools/config-release-gate.ts`.
 *
 * Exit codes: 0 identical (or compare skipped), 1 surface differs, 2 tool failure.
 */

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  Cause,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schema,
} from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  type CompareResult,
  countByStatus,
  countDeclarationFiles,
  diffDeclarationTrees,
  renderDiffDetailsBlocks,
  writeStepSummary,
} from "./lib/dts-diff.ts";

const toolPaths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dir, "..");
  const packageRoot = path.join(repoRoot, "packages", "config");
  const tscBinPath = path.join(packageRoot, "node_modules", ".bin", "tsc");
  return { repoRoot, packageRoot, tscBinPath };
});

class ConfigApiCompareError extends Schema.TaggedError<ConfigApiCompareError>()(
  "ConfigApiCompareError",
  { message: Schema.String },
) {}

const foreignFailure = (cause: unknown) =>
  new ConfigApiCompareError({ message: cause instanceof Error ? cause.message : String(cause) });

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runGit = Effect.fnUntraced(function* (
  args: readonly string[],
  cwd: string,
): Effect.fn.Return<GitResult, ConfigApiCompareError> {
  const proc = yield* Effect.try({
    try: () => Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }),
    catch: foreignFailure,
  });
  const [exitCode, stdout, stderr] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
    catch: foreignFailure,
  });
  return { exitCode, stdout, stderr };
});

const requireBinaries = Effect.fnUntraced(function* (names: readonly string[]) {
  const missing = names.filter((name) => Bun.which(name) === null);
  if (missing.length > 0) {
    return yield* new ConfigApiCompareError({
      message: `this tool requires ${missing.join(", ")} on PATH.`,
    });
  }
});

/** `--base` wins; else `GITHUB_BASE_REF` (a PR's base branch name, no remote prefix) under `origin/`; else `origin/develop`. */
const resolveBaseRef = Effect.fnUntraced(function* (cliBase: string | undefined) {
  if (cliBase) {
    return cliBase;
  }
  const githubBaseRef = yield* Config.String("GITHUB_BASE_REF").pipe(Config.withDefault(""));
  if (githubBaseRef) {
    return `origin/${githubBaseRef}`;
  }
  return "origin/develop";
});

type MergeBaseResolution =
  | { readonly kind: "resolved"; readonly sha: string }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * Resolves `git merge-base HEAD <baseRef>`. Fetches a missing `origin/<branch>` ref at depth 1,
 * unshallowing the checkout if that still isn't enough to find a common ancestor.
 */
const resolveMergeBase = Effect.fnUntraced(function* (
  baseRef: string,
): Effect.fn.Return<MergeBaseResolution, ConfigApiCompareError, Path.Path> {
  const { repoRoot } = yield* toolPaths;
  const attempt = yield* runGit(["merge-base", "HEAD", baseRef], repoRoot);
  if (attempt.exitCode === 0) {
    return { kind: "resolved", sha: attempt.stdout.trim() };
  }

  if (!baseRef.startsWith("origin/")) {
    return yield* new ConfigApiCompareError({
      message:
        `could not resolve base ref "${baseRef}" (git merge-base: ${attempt.stderr.trim()}). Pass a ` +
        `ref that already exists locally, or one under "origin/" so it can be fetched.`,
    });
  }

  const branchName = baseRef.slice("origin/".length);
  yield* Console.warn(
    `[config-api-compare] ${baseRef} did not resolve locally (${attempt.stderr.trim()}); fetching ` +
      `origin/${branchName} at depth 1...`,
  );
  const fetch = yield* runGit(
    ["fetch", "--depth=1", "origin", `+${branchName}:refs/remotes/origin/${branchName}`],
    repoRoot,
  );
  if (fetch.exitCode !== 0) {
    return yield* new ConfigApiCompareError({
      message: `git fetch --depth=1 origin ${branchName} failed: ${fetch.stderr.trim()}`,
    });
  }

  const retry = yield* runGit(["merge-base", "HEAD", baseRef], repoRoot);
  if (retry.exitCode === 0) {
    return { kind: "resolved", sha: retry.stdout.trim() };
  }

  const isShallow = yield* runGit(["rev-parse", "--is-shallow-repository"], repoRoot);
  if (isShallow.stdout.trim() !== "true") {
    return yield* new ConfigApiCompareError({
      message:
        `could not resolve base ref "${baseRef}" even after fetching origin/${branchName}: ` +
        retry.stderr.trim(),
    });
  }

  yield* Console.warn(
    `[config-api-compare] HEAD's own checkout is shallow, so a depth-1 ${baseRef} fetch can't ` +
      "produce a common ancestor; unshallowing before retrying merge-base...",
  );
  const unshallow = yield* runGit(["fetch", "--unshallow", "origin", branchName], repoRoot);
  if (unshallow.exitCode !== 0) {
    yield* Console.warn(
      `[config-api-compare] git fetch --unshallow failed (${unshallow.stderr.trim()}); falling ` +
        "back to git fetch --deepen=100000...",
    );
    const deepen = yield* runGit(["fetch", "--deepen=100000", "origin"], repoRoot);
    if (deepen.exitCode !== 0) {
      return {
        kind: "skip",
        reason:
          `could not unshallow (${unshallow.stderr.trim()}) or deepen ` +
          `(${deepen.stderr.trim()}) the checkout to resolve a merge-base against ${baseRef}.`,
      };
    }
  }

  const fullFetch = yield* runGit(
    ["fetch", "origin", `+${branchName}:refs/remotes/origin/${branchName}`],
    repoRoot,
  );
  if (fullFetch.exitCode !== 0) {
    return {
      kind: "skip",
      reason: `could not fully fetch origin/${branchName} after unshallowing: ${fullFetch.stderr.trim()}.`,
    };
  }

  const finalRetry = yield* runGit(["merge-base", "HEAD", baseRef], repoRoot);
  if (finalRetry.exitCode === 0) {
    return { kind: "resolved", sha: finalRetry.stdout.trim() };
  }

  return {
    kind: "skip",
    reason:
      `could not resolve a merge-base between HEAD and ${baseRef} even after unshallowing ` +
      `(git merge-base: ${finalRetry.stderr.trim()}).`,
  };
});

const shortSha = Effect.fnUntraced(function* (rev: string) {
  const { repoRoot } = yield* toolPaths;
  const result = yield* runGit(["rev-parse", "--short", rev], repoRoot);
  return result.exitCode === 0 ? result.stdout.trim() : rev;
});

const pathExistsAtRev = Effect.fnUntraced(function* (rev: string, relativePath: string) {
  const { repoRoot } = yield* toolPaths;
  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn(["git", "cat-file", "-e", `${rev}:${relativePath}`], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      }),
    catch: foreignFailure,
  });
  return (yield* Effect.tryPromise({ try: () => proc.exited, catch: foreignFailure })) === 0;
});

/**
 * `git archive <rev> <relativePaths>` piped straight into `tar -x`, stripping
 * the shared `packages/config/` prefix (2 path components) so the extracted
 * tree lands directly under `destDir`.
 */
const archiveAndExtract = Effect.fnUntraced(function* (
  rev: string,
  relativePaths: readonly string[],
  destDir: string,
) {
  const { repoRoot } = yield* toolPaths;
  const archiveProc = yield* Effect.try({
    try: () =>
      Bun.spawn(["git", "archive", rev, ...relativePaths], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: foreignFailure,
  });
  const tarProc = yield* Effect.try({
    try: () =>
      Bun.spawn(["tar", "-x", "-C", destDir, "--strip-components=2"], {
        stdin: archiveProc.stdout,
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: foreignFailure,
  });
  const [archiveExitCode, tarExitCode, archiveStderr, tarStderr] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        archiveProc.exited,
        tarProc.exited,
        new Response(archiveProc.stderr).text(),
        new Response(tarProc.stderr).text(),
      ]),
    catch: foreignFailure,
  });
  if (archiveExitCode !== 0) {
    return yield* new ConfigApiCompareError({
      message: `git archive ${rev} ${relativePaths.join(" ")} failed: ${archiveStderr.trim()}`,
    });
  }
  if (tarExitCode !== 0) {
    return yield* new ConfigApiCompareError({
      message: `tar extraction into ${destDir} failed: ${tarStderr.trim()}`,
    });
  }
});

/**
 * Materializes the base revision's `packages/config/src` under `baseExtractDir`, inside
 * `packages/config`, so tsc's node_modules walk reaches the current install. `tsconfig.build.json`
 * stays the head copy so `extends` resolves; the declarations config uses the base's own copy
 * when present, else the head copy.
 */
const extractBaseTree = Effect.fnUntraced(function* (mergeBase: string, baseExtractDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { packageRoot } = yield* toolPaths;
  yield* fs.makeDirectory(baseExtractDir, { recursive: true });

  const srcRelativePath = "packages/config/src";
  const declarationsRelativePath = "packages/config/tsconfig.declarations.json";

  if (!(yield* pathExistsAtRev(mergeBase, srcRelativePath))) {
    return yield* new ConfigApiCompareError({
      message: `base revision ${mergeBase} has no ${srcRelativePath} — cannot compare`,
    });
  }

  const hasDeclarationsConfig = yield* pathExistsAtRev(mergeBase, declarationsRelativePath);
  const archivePaths = hasDeclarationsConfig
    ? [srcRelativePath, declarationsRelativePath]
    : [srcRelativePath];
  yield* archiveAndExtract(mergeBase, archivePaths, baseExtractDir);

  yield* fs.copy(
    path.join(packageRoot, "tsconfig.build.json"),
    path.join(baseExtractDir, "tsconfig.build.json"),
    { overwrite: true },
  );
  if (!hasDeclarationsConfig) {
    yield* Console.warn(
      `[config-api-compare] base revision ${yield* shortSha(mergeBase)} predates ` +
        "tsconfig.declarations.json — using the HEAD copy for emit settings.",
    );
    yield* fs.copy(
      path.join(packageRoot, "tsconfig.declarations.json"),
      path.join(baseExtractDir, "tsconfig.declarations.json"),
      { overwrite: true },
    );
  }
});

interface EmitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly fileCount: number;
}

/**
 * Spawns this package's own `node_modules/.bin/tsc` directly: a bun-shimmed `PATH` can route
 * `pnpm exec tsc` through Bun's `node:sqlite`-less Node-compat layer. `noEmitOnError` defaults to
 * false, so declarations still emit against an old, non-type-checking base tree; only a fully
 * empty output counts as failure.
 */
const emitDeclarations = Effect.fnUntraced(function* (
  projectPath: string,
  outDir: string,
  cwd: string,
) {
  const { tscBinPath } = yield* toolPaths;
  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn([tscBinPath, "-p", projectPath, "--outDir", outDir], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: foreignFailure,
  });
  const [exitCode, stdout, stderr] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
    catch: foreignFailure,
  });
  const fileCount = yield* countDeclarationFiles(outDir);
  return { exitCode, stdout, stderr, fileCount };
});

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
      "declaration surface. Advisory only — the release-time hard gate is " +
      "`tools/config-release-gate.ts`, run by the Release Config workflow (CLI-2233).",
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
  lines.push(...renderDiffDetailsBlocks(result.entries));
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

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { packageRoot } = yield* toolPaths;
  yield* requireBinaries(["git", "tar", "diff"]);

  const { values } = yield* Effect.try({
    try: () => parseArgs({ options: { base: { type: "string" } } }),
    catch: foreignFailure,
  });
  const baseRef = yield* resolveBaseRef(values.base);
  const mergeBaseResolution = yield* resolveMergeBase(baseRef);
  if (mergeBaseResolution.kind === "skip") {
    const headLabel = yield* shortSha("HEAD");
    yield* Console.warn(`[config-api-compare] WARNING: ${mergeBaseResolution.reason}`);
    yield* writeStepSummary(
      renderShallowHistorySkippedSummary(baseRef, headLabel, mergeBaseResolution.reason),
    );
    return 0;
  }
  const mergeBase = mergeBaseResolution.sha;
  const [baseLabel, headLabel] = yield* Effect.all([shortSha(mergeBase), shortSha("HEAD")], {
    concurrency: "unbounded",
  });
  yield* Console.log(
    `[config-api-compare] comparing merge-base ${baseLabel} (of ${baseRef}) against HEAD ${headLabel}...`,
  );

  const compareDir = path.join(packageRoot, ".api-compare");
  const baseExtractDir = path.join(compareDir, "base");
  const headOutDir = yield* fs.makeTempDirectory({ prefix: "supabase-config-api-compare-head-" });
  const baseOutDir = yield* fs.makeTempDirectory({ prefix: "supabase-config-api-compare-base-" });

  const exit = yield* Effect.gen(function* () {
    yield* fs.remove(compareDir, { recursive: true, force: true });

    yield* Console.log("[config-api-compare] emitting head declarations...");
    const headEmit = yield* emitDeclarations(
      path.join(packageRoot, "tsconfig.declarations.json"),
      headOutDir,
      packageRoot,
    );
    if (headEmit.fileCount === 0) {
      return yield* new ConfigApiCompareError({
        message:
          `head declaration emit produced zero .d.ts files (tsc exit ${headEmit.exitCode}):\n` +
          `${headEmit.stdout}\n${headEmit.stderr}`,
      });
    }

    yield* Console.log("[config-api-compare] extracting and emitting base declarations...");
    yield* extractBaseTree(mergeBase, baseExtractDir);
    const baseEmit = yield* emitDeclarations(
      path.join(baseExtractDir, "tsconfig.declarations.json"),
      baseOutDir,
      baseExtractDir,
    );
    if (baseEmit.fileCount === 0) {
      yield* Console.warn(
        `[config-api-compare] WARNING: base declaration emit produced zero .d.ts files (tsc exit ` +
          `${baseEmit.exitCode}) — skipping the compare rather than reporting a false surface diff.\n` +
          baseEmit.stderr,
      );
      yield* writeStepSummary(renderSkippedSummary(baseLabel, headLabel, baseEmit));
      return 0;
    }

    const result = yield* diffDeclarationTrees(headOutDir, baseOutDir);
    yield* Console.log(renderTextReport(baseLabel, headLabel, result));
    yield* writeStepSummary(renderMarkdownSummary(baseLabel, headLabel, result));

    return result.identical ? 0 : 1;
  }).pipe(Effect.exit);
  yield* Effect.all(
    [
      fs.remove(compareDir, { recursive: true, force: true }),
      fs.remove(headOutDir, { recursive: true, force: true }),
      fs.remove(baseOutDir, { recursive: true, force: true }),
    ],
    { concurrency: "unbounded" },
  );
  return yield* exit;
});

process.exit(
  await Effect.runPromise(
    main.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        /* Prints a PlatformError's underlying cause message when it has one, not the PlatformError summary. */
        const reported =
          PlatformError.isPlatformError(error) && error.cause instanceof Error
            ? error.cause
            : error;
        return Console.error(
          `[config-api-compare] ${reported instanceof Error ? reported.message : String(reported)}`,
        ).pipe(Effect.as(2));
      }),
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    ),
  ),
);

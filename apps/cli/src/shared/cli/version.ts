import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

// `CLI_VERSION` is injected at compile time by the build scripts. The source
// fallback is intentionally display-only; runtime compatibility uses the
// deterministic `resolveCliBuildIdentity` effect below.
export const CLI_VERSION = process.env.SUPABASE_CLI_VERSION ?? "0.0.0-dev";

export interface CliBuildIdentity {
  readonly cliVersion: string;
  readonly buildId: string;
}

type SourceIdentityFile =
  | {
      readonly path: string;
      readonly content: Uint8Array;
    }
  | {
      readonly path: string;
      readonly size: number;
      readonly mtimeMs: number;
    };

export interface SourceIdentitySnapshot {
  readonly repositoryRoot: string;
  readonly head: string;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly untrackedFiles: ReadonlyArray<SourceIdentityFile>;
}

export class CliBuildIdentityError extends Data.TaggedError("CliBuildIdentityError")<{
  readonly reason: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.impossibleState, fingerprint_suffix: "internal_build" };
  }
}

const SOURCE_SENTINELS = new Set(["", "0.0.0-dev", "dev", "unknown"]);

/** Maximum size of an untracked source file whose raw bytes are hashed. */
const MAX_UNTRACKED_FILE_BYTES = 1_048_576;

const runGit = (repositoryRoot: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const isRelevantUntracked = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith(".git/") ||
    normalized.includes("/node_modules/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/.cache/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("target/")
  ) {
    return false;
  }
  return true;
};

const findRepositoryRoot = (start: string): string | undefined => {
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const captureSourceIdentity = (repositoryRoot?: string): SourceIdentitySnapshot => {
  const root =
    repositoryRoot ??
    (() => {
      const sourcePath = fileURLToPath(import.meta.url);
      return findRepositoryRoot(dirname(sourcePath));
    })();
  if (root === undefined) throw new Error("source repository root is unavailable");
  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  if (head.length === 0) throw new Error("source repository has no HEAD");
  const stagedDiff = runGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  const unstagedDiff = runGit(root, ["diff", "--binary", "--no-ext-diff"]);
  const untrackedOutput = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untrackedFiles = untrackedOutput
    .split("\0")
    .filter((path) => path.length > 0 && isRelevantUntracked(path))
    .sort()
    .map((path) => {
      const absolutePath = join(root, path);
      const stats = statSync(absolutePath);
      if (!stats.isFile()) throw new Error(`untracked source is not a file: ${path}`);
      return stats.size <= MAX_UNTRACKED_FILE_BYTES
        ? { path, content: readFileSync(absolutePath) }
        : { path, size: stats.size, mtimeMs: stats.mtimeMs };
    });
  return { repositoryRoot: root, head, stagedDiff, unstagedDiff, untrackedFiles };
};

/** @internal Captures source identity from a repository root for build tooling and integration tests. */
export const captureCliSourceIdentityAt = (repositoryRoot: string): SourceIdentitySnapshot =>
  captureSourceIdentity(repositoryRoot);

const hashSourceIdentity = (source: SourceIdentitySnapshot): string => {
  const digest = createHash("sha256");
  digest.update(source.head);
  digest.update("\0");
  digest.update(source.stagedDiff);
  digest.update("\0");
  digest.update(source.unstagedDiff);
  for (const file of [...source.untrackedFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update("\0");
    digest.update(file.path);
    digest.update("\0");
    if ("content" in file) {
      digest.update(file.content);
    } else {
      digest.update("metadata\0");
      digest.update(String(file.size));
      digest.update("\0");
      digest.update(String(file.mtimeMs));
    }
  }
  return `source:${digest.digest("hex")}`;
};

export const resolveCliBuildIdentity = (
  input: {
    readonly cliVersion?: string;
    readonly release?: boolean;
    readonly source?: SourceIdentitySnapshot | null;
  } = {},
): Effect.Effect<CliBuildIdentity, CliBuildIdentityError> =>
  Effect.try({
    try: () => {
      const cliVersion = input.cliVersion ?? CLI_VERSION;
      const injectedBuildId = process.env.SUPABASE_CLI_BUILD_ID;
      const release = input.release ?? injectedBuildId?.startsWith("release:") ?? false;
      if (release) {
        if (cliVersion.length === 0 || SOURCE_SENTINELS.has(cliVersion)) {
          throw new Error("release build is missing an immutable CLI version");
        }
        return { cliVersion, buildId: `release:${cliVersion}` };
      }
      if (injectedBuildId !== undefined && !SOURCE_SENTINELS.has(injectedBuildId)) {
        return { cliVersion, buildId: injectedBuildId };
      }
      if (input.source === null) throw new Error("source identity is unavailable");
      const source = input.source ?? captureSourceIdentity();
      return { cliVersion, buildId: hashSourceIdentity(source) };
    },
    catch: (cause) =>
      new CliBuildIdentityError({
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/** Identity used by stack composition; source mode fails closed if git is unavailable. */
export const currentCliBuildIdentity = resolveCliBuildIdentity();

import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { InvalidStackIdentityError } from "../public/Errors.ts";

const FULL_REF_PATTERN = /^refs\/.+$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const invalidMetadata = (path: string, reason: string): InvalidStackIdentityError =>
  new InvalidStackIdentityError({ path, reason, message: reason });

const canonicalGitDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  checkoutRoot: string,
  gitEntry: string,
): Effect.Effect<string, InvalidStackIdentityError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(gitEntry);
    if (info.type === "Directory") {
      return yield* fs.realPath(gitEntry);
    }
    if (info.type !== "File") {
      return yield* invalidMetadata(
        gitEntry,
        "The .git entry is neither a directory nor a gitdir file",
      );
    }

    const content = yield* fs.readFileString(gitEntry);
    const line = content
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.toLowerCase().startsWith("gitdir:"));
    const target = line?.slice("gitdir:".length).trim();
    if (target === undefined || target.length === 0) {
      return yield* invalidMetadata(gitEntry, "The .git file does not contain a gitdir target");
    }
    return yield* fs.realPath(path.resolve(checkoutRoot, target));
  }).pipe(
    Effect.catchTag("PlatformError", (error: PlatformError) =>
      Effect.fail(invalidMetadata(gitEntry, `Unable to read Git metadata: ${error.message}`)),
    ),
  );

const locateGitDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalProjectRoot: string,
): Effect.Effect<string | undefined, InvalidStackIdentityError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    let directory = canonicalProjectRoot;
    while (true) {
      const gitEntry = path.join(directory, ".git");
      if (yield* fs.exists(gitEntry)) {
        return yield* canonicalGitDirectory(fs, path, directory, gitEntry);
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  }).pipe(
    Effect.catchTag("PlatformError", (error: PlatformError) =>
      Effect.fail(
        invalidMetadata(canonicalProjectRoot, `Unable to inspect Git metadata: ${error.message}`),
      ),
    ),
  );

const resolveBranchContext = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  gitDirectory: string,
): Effect.Effect<string, InvalidStackIdentityError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const headPath = path.join(gitDirectory, "HEAD");
    const head = (yield* fs.readFileString(headPath)).trim();
    if (head.length === 0) {
      return yield* invalidMetadata(headPath, "HEAD is empty");
    }
    if (head.startsWith("ref:")) {
      const ref = head.slice("ref:".length).trim();
      if (!FULL_REF_PATTERN.test(ref)) {
        return yield* invalidMetadata(headPath, "HEAD must name a full symbolic ref under refs/");
      }
      return ref;
    }
    if (!OBJECT_ID_PATTERN.test(head)) {
      return yield* invalidMetadata(
        headPath,
        "Detached HEAD must contain a 40- or 64-character hexadecimal Git object id",
      );
    }
    return "detached";
  }).pipe(
    Effect.catchTag("PlatformError", (error: PlatformError) =>
      Effect.fail(
        invalidMetadata(path.join(gitDirectory, "HEAD"), `Unable to read HEAD: ${error.message}`),
      ),
    ),
  );

/** Resolves Git metadata without spawning Git or writing identity markers. */
export const resolveGitBranchContext = (
  canonicalProjectRoot: string,
): Effect.Effect<
  string | undefined,
  InvalidStackIdentityError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitDirectory = yield* locateGitDirectory(fs, path, canonicalProjectRoot);
    if (gitDirectory === undefined) return undefined;
    return yield* resolveBranchContext(fs, path, gitDirectory);
  });

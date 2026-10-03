import { Effect, FileSystem, Predicate } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has neither a no-follow stat nor a non-recursive directory removal.
import { lstat, rmdir } from "node:fs/promises";
import { namespaceError, type NamespaceError } from "../Capabilities.ts";

export interface LstatInfo {
  readonly type: "Directory" | "SymbolicLink" | "File" | "Other";
  readonly uid: number;
  readonly mode: number;
}

const toLstatInfo = (stats: Awaited<ReturnType<typeof lstat>>): LstatInfo => ({
  type: stats.isSymbolicLink()
    ? "SymbolicLink"
    : stats.isDirectory()
      ? "Directory"
      : stats.isFile()
        ? "File"
        : "Other",
  uid: Number(stats.uid),
  mode: Number(stats.mode),
});

const toLstatError = (path: string, cause: unknown): PlatformError =>
  systemError({
    _tag: Predicate.hasProperty(cause, "code") && cause.code === "ENOENT" ? "NotFound" : "Unknown",
    module: "FileSystem",
    method: "lstat",
    pathOrDescriptor: path,
    cause,
  });

/**
 * No-follow metadata for `path`: a single `lstat` syscall that never resolves a symlink, closing
 * the time-of-check gap between a probe and a later symlink-following stat. Resolves to `undefined`
 * when `path` has no entry at all.
 */
export const lstatPath = (path: string): Effect.Effect<LstatInfo | undefined, PlatformError> =>
  Effect.tryPromise({ try: () => lstat(path), catch: (cause) => toLstatError(path, cause) }).pipe(
    Effect.map(toLstatInfo),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- the success type is `undefined`, not `void`.
      () => Effect.succeed(undefined),
    ),
  );

/** Removes a directory only if it is already empty; any other failure propagates. */
export const removeEmptyDirectory = (directory: string): Effect.Effect<void, NamespaceError> =>
  Effect.tryPromise({
    try: () => rmdir(directory),
    catch: (cause) => namespaceError("cleanup", cause),
  }).pipe(
    Effect.catchIf(
      (error) =>
        Predicate.hasProperty(error.cause, "code") &&
        ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.cause.code)),
      () => Effect.void,
    ),
  );

/** Flushes a file's contents to durable storage. */
export const fsyncFile = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<void, PlatformError> =>
  Effect.scoped(fs.open(target, { flag: "r+" }).pipe(Effect.flatMap((file) => file.sync)));

/** Flushes a directory's own metadata; a no-op on Windows, which can't open or fsync directories. */
export const fsyncDirectory = (
  fs: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<void, PlatformError> =>
  process.platform === "win32"
    ? Effect.void
    : Effect.scoped(fs.open(directory, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)));

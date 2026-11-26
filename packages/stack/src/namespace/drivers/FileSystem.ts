import { Effect, FileSystem, Predicate } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no no-follow stat or open, and no non-recursive directory removal.
import { constants, lstat, open, realpath, rmdir, stat } from "node:fs/promises";
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

const fileError = (
  path: string,
  tag: "Unknown" | "BadResource",
  detail: { readonly cause?: unknown; readonly description?: string },
): PlatformError =>
  systemError({
    _tag: tag,
    module: "FileSystem",
    method: "readContainedFile",
    pathOrDescriptor: path,
    ...detail,
  });

const notRegularFile = (path: string) =>
  fileError(path, "BadResource", { description: "Not a regular file at this path" });

/** A path's form for comparison: Windows names are case-insensitive, so they compare folded. */
const comparable = (path: string, windows: boolean) => (windows ? path.toLowerCase() : path);

/**
 * Whether canonical `path` is `root` or below it, the containment rule `content_path` follows
 * in the CLI; both come from `realpath`, so neither holds a `..` segment.
 */
export const containedIn = (root: string, path: string, windows: boolean): boolean => {
  const sep = windows ? "\\" : "/";
  const base = comparable(root.endsWith(sep) ? root : `${root}${sep}`, windows);
  const candidate = comparable(path, windows);
  return candidate === comparable(root, windows) || candidate.startsWith(base);
};

/** Reads the file `path` resolves to while it stays inside `root`, like `content_path` in the CLI. */
export const readContainedFile = (
  path: string,
  root: string,
): Effect.Effect<Uint8Array, PlatformError> => {
  const attempt = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => fileError(path, "Unknown", { cause }),
    });
  const windows = process.platform === "win32";
  const read = Effect.gen(function* () {
    const resolved = yield* attempt(() => realpath(path));
    if (!containedIn(yield* attempt(() => realpath(root)), resolved, windows))
      return yield* fileError(path, "BadResource", {
        description: "Resolves outside the template root",
      });
    return yield* readResolvedFile(resolved, windows);
  });
  /* A retry reopens a file replaced mid-check. */
  return read.pipe(
    Effect.retry({ times: 2 }),
    Effect.tap((bytes) => Effect.annotateCurrentSpan({ "template.bytes": bytes.length })),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({
        "template.refusal": error.reason.description ?? "unreadable",
      }),
    ),
    Effect.withSpan("FileSystem.readContainedFile"),
  );
};

/**
 * Reads canonical `resolved` only through a handle on a regular file that is still the file at
 * `resolved` (same device and inode once the path re-resolves to itself), so a link swapped in
 * after `realpath` is refused rather than read. POSIX also opens without following a final link
 * or blocking on a FIFO.
 */
export const readResolvedFile = (
  resolved: string,
  windows: boolean,
): Effect.Effect<Uint8Array, PlatformError> => {
  const attempt = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => fileError(resolved, "Unknown", { cause }),
    });
  const flags = windows
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  return Effect.acquireUseRelease(
    attempt(() => open(resolved, flags)),
    (handle) =>
      Effect.gen(function* () {
        const opened = yield* attempt(() => handle.stat({ bigint: true }));
        if (!opened.isFile()) return yield* notRegularFile(resolved);
        const canonical = yield* attempt(() => realpath(resolved));
        const current = yield* attempt(() => stat(resolved, { bigint: true }));
        if (
          comparable(canonical, windows) !== comparable(resolved, windows) ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino
        )
          return yield* notRegularFile(resolved);
        return yield* attempt((signal) => handle.readFile({ signal }));
      }),
    (handle) => attempt(() => handle.close()).pipe(Effect.ignore),
  );
};

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

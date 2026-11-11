import { Effect, FileSystem, Predicate } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no no-follow stat or open, and no non-recursive directory removal.
import { constants, lstat, open, realpath, rmdir } from "node:fs/promises";
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

/**
 * The DOS path `GetFinalPathNameByHandleW` reports, without its `\\?\` prefix, so it reads like
 * `realpath`: `\\?\C:\x` is `C:\x` and `\\?\UNC\server\share` is `\\server\share`.
 */
export const windowsFinalPath = (reported: string): string =>
  reported.startsWith("\\\\?\\UNC\\")
    ? `\\\\${reported.slice(8)}`
    : reported.startsWith("\\\\?\\")
      ? reported.slice(4)
      : reported;

const GENERIC_READ = 0x8000_0000;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const WINDOWS_PATH_CHARS = 32_768;

/**
 * Windows: opens `resolved` the normal way, so OneDrive placeholders and deduplicated files read,
 * and reads it only when the handle's final path is still `resolved` and names a file, so a link
 * swapped in anywhere on the path is refused. Node has no handle-path API there.
 */
const readWindowsHandle = Effect.fnUntraced(function* (resolved: string) {
  const sync = <A>(operation: () => A) =>
    Effect.try({ try: operation, catch: (cause) => fileError(resolved, "Unknown", { cause }) });
  const { dlopen, FFIType } = yield* Effect.tryPromise({
    try: () => import("bun:ffi"),
    catch: (cause) => fileError(resolved, "Unknown", { cause }),
  });
  const { symbols } = yield* Effect.acquireRelease(
    sync(() =>
      dlopen("kernel32.dll", {
        CreateFileW: {
          args: [
            FFIType.ptr,
            FFIType.u32,
            FFIType.u32,
            FFIType.ptr,
            FFIType.u32,
            FFIType.u32,
            FFIType.ptr,
          ],
          returns: FFIType.i64,
        },
        GetFinalPathNameByHandleW: {
          args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32],
          returns: FFIType.u32,
        },
        GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
        ReadFile: {
          args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
      }),
    ),
    (library) => Effect.sync(() => library.close()),
  );
  const handle = yield* Effect.acquireRelease(
    sync(() =>
      symbols.CreateFileW(
        Buffer.from(`${resolved}\0`, "utf16le"),
        GENERIC_READ,
        FILE_SHARE_ALL,
        null,
        OPEN_EXISTING,
        0,
        null,
      ),
    ),
    (opened) =>
      Number(opened) === -1 ? Effect.void : Effect.sync(() => symbols.CloseHandle(opened)),
  );
  if (Number(handle) === -1)
    return yield* fileError(resolved, "Unknown", { description: "Could not open the file" });
  const unreadable = fileError(resolved, "Unknown", { description: "Could not read the file" });
  const info = new Uint32Array(13);
  if ((yield* sync(() => symbols.GetFileInformationByHandle(handle, info))) === 0)
    return yield* unreadable;
  if (((info[0] ?? FILE_ATTRIBUTE_DIRECTORY) & FILE_ATTRIBUTE_DIRECTORY) !== 0)
    return yield* notRegularFile(resolved);
  const name = new Uint16Array(WINDOWS_PATH_CHARS);
  const length = yield* sync(() =>
    symbols.GetFinalPathNameByHandleW(handle, name, WINDOWS_PATH_CHARS, 0),
  );
  if (length === 0 || length >= WINDOWS_PATH_CHARS) return yield* unreadable;
  const final = windowsFinalPath(Buffer.from(name.buffer, 0, length * 2).toString("utf16le"));
  if (comparable(final, true) !== comparable(resolved, true))
    return yield* notRegularFile(resolved);
  const size = (info[8] ?? 0) * 2 ** 32 + (info[9] ?? 0);
  const bytes = yield* sync(() => new Uint8Array(size));
  const read = new Uint32Array(1);
  let offset = 0;
  while (offset < size) {
    const at = offset;
    const ok = yield* sync(() =>
      symbols.ReadFile(handle, bytes.subarray(at), size - at, read, null),
    );
    if (ok === 0 || read[0] === undefined || read[0] === 0) return yield* unreadable;
    offset += read[0];
  }
  return bytes;
}, Effect.scoped);

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
 * Reads canonical `resolved` only through a handle that still names `resolved` and a regular file
 * (`/dev/fd` on macOS and Linux, opened without following a link or blocking on a FIFO; the final
 * handle path on Windows), so a swap after `realpath` is refused rather than read.
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
  if (windows) return readWindowsHandle(resolved);
  return Effect.acquireUseRelease(
    attempt(() => open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
    (handle) =>
      Effect.gen(function* () {
        const stats = yield* attempt(() => handle.stat());
        /* On macOS, Bun resolves /dev/fd/N to the file; libc realpath doesn't, which refuses. */
        const opened = stats.isFile()
          ? yield* attempt(() => realpath(`/dev/fd/${handle.fd}`))
          : undefined;
        if (opened !== resolved) return yield* notRegularFile(resolved);
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

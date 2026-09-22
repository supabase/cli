// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no lstat or clone-copy operation.
import { copyFile as nativeCopyFile, lstat } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no clone-copy flags.
import { constants as fsConstants } from "node:fs";
import { Effect, FileSystem, Path, Schema } from "effect";

export class DirectoryCopyError extends Schema.TaggedError<DirectoryCopyError>()(
  "DirectoryCopyError",
  {
    operation: Schema.String,
    source: Schema.String,
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class NativeFileError extends Schema.TaggedError<NativeFileError>()("NativeFileError", {
  cause: Schema.Defect(),
}) {}

type NativeStats = Awaited<ReturnType<typeof lstat>>;

const errorFor = (operation: string, source: string, destination: string, cause: unknown) =>
  new DirectoryCopyError({ operation, source, destination, cause });

const isCloneUnsupported = (cause: unknown): boolean => {
  if (Schema.is(NativeFileError)(cause)) return isCloneUnsupported(cause.cause);
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  const code = cause.code;
  return (
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS" ||
    code === "EXDEV" ||
    code === "EINVAL"
  );
};

const isNotFound = (cause: unknown): boolean =>
  Schema.is(NativeFileError)(cause)
    ? isNotFound(cause.cause)
    : typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

// FileSystem does not expose lstat or clone flags, so these two operations stay at the
// native boundary while the traversal and directory operations use the Effect service.
const nativeLstat = (target: string): Effect.Effect<NativeStats, NativeFileError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => lstat(target),
      catch: (cause) => new NativeFileError({ cause }),
    }),
  );

const nativeCopy = (
  source: string,
  destination: string,
  clone: boolean,
): Effect.Effect<void, NativeFileError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () =>
        nativeCopyFile(source, destination, clone ? fsConstants.COPYFILE_FICLONE_FORCE : 0),
      catch: (cause) => new NativeFileError({ cause }),
    }),
  );

const inspect = (
  source: string,
  destination: string,
): Effect.Effect<NativeStats, DirectoryCopyError> =>
  nativeLstat(source).pipe(
    Effect.mapError((cause) => errorFor("lstat", source, destination, cause)),
  );

const copyFile = (source: string, destination: string): Effect.Effect<void, DirectoryCopyError> => {
  const regular = nativeCopy(source, destination, false).pipe(
    Effect.mapError((cause) => errorFor("copyFile", source, destination, cause)),
  );
  if (process.platform === "win32") return regular;
  return nativeCopy(source, destination, true).pipe(
    Effect.catch((cause: NativeFileError) =>
      isCloneUnsupported(cause)
        ? regular
        : Effect.fail(errorFor("copyFile", source, destination, cause)),
    ),
  );
};

const validateTree = (
  source: string,
  destination: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<void, DirectoryCopyError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const stats = yield* inspect(source, destination);
    if (stats.isSymbolicLink())
      return yield* errorFor("validate", source, destination, "symbolic link");
    if (!stats.isDirectory())
      return yield* errorFor("validate", source, destination, "not a directory");
    const entries = yield* fs
      .readDirectory(source)
      .pipe(Effect.mapError((cause) => errorFor("readDirectory", source, destination, cause)));
    for (const entry of entries) {
      const childSource = path.join(source, entry);
      const childDestination = path.join(destination, entry);
      const childStats = yield* inspect(childSource, childDestination);
      if (childStats.isSymbolicLink())
        return yield* errorFor("validate", childSource, childDestination, "symbolic link");
      if (childStats.isDirectory()) yield* validateTree(childSource, childDestination, fs, path);
      else if (!childStats.isFile())
        return yield* errorFor("validate", childSource, childDestination, "special file");
    }
  });

const copyTree = (
  source: string,
  destination: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<void, DirectoryCopyError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const sourceStats = yield* inspect(source, destination);
    if (sourceStats.isSymbolicLink())
      return yield* errorFor("validate", source, destination, "symbolic link");
    if (sourceStats.isDirectory() === false)
      return yield* errorFor("validate", source, destination, "not a directory");

    yield* fs
      .makeDirectory(destination, {
        mode: (Number(sourceStats.mode) | 0o700) & 0o7777,
      })
      .pipe(Effect.mapError((cause) => errorFor("makeDirectory", source, destination, cause)));

    const entries = yield* fs
      .readDirectory(source)
      .pipe(Effect.mapError((cause) => errorFor("readDirectory", source, destination, cause)));
    for (const entry of entries) {
      const childSource = path.join(source, entry);
      const childDestination = path.join(destination, entry);
      const childStats = yield* inspect(childSource, childDestination);
      if (childStats.isSymbolicLink())
        return yield* errorFor("validate", childSource, childDestination, "symbolic link");
      if (childStats.isDirectory()) {
        yield* copyTree(childSource, childDestination, fs, path);
      } else if (childStats.isFile()) {
        yield* copyFile(childSource, childDestination);
        yield* fs
          .chmod(childDestination, Number(childStats.mode) & 0o7777)
          .pipe(
            Effect.mapError((cause) => errorFor("chmod", childSource, childDestination, cause)),
          );
      } else {
        return yield* errorFor("validate", childSource, childDestination, "special file");
      }
    }
    yield* fs
      .chmod(destination, Number(sourceStats.mode) & 0o7777)
      .pipe(Effect.mapError((cause) => errorFor("chmod", source, destination, cause)));
  });

export const copyDirectory = Effect.fn("DirectoryCopy.copyDirectory")(function* (
  source: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* nativeLstat(destination).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        isNotFound(cause)
          ? Effect.void
          : Effect.fail(errorFor("lstat", source, destination, cause)),
      onSuccess: () => Effect.fail(errorFor("validate", source, destination, "destination exists")),
    }),
  );
  yield* validateTree(source, destination, fs, path);
  return yield* copyTree(source, destination, fs, path);
});

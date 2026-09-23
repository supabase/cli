// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no lstat or clone-copy operation.
import { copyFile as nativeCopyFile, lstat, readdir } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no clone-copy flags.
import { constants as fsConstants } from "node:fs";
import { Cause, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
  // cp and robocopy keep or follow links. Only a plain directory tree can use them.
  const copies = hostCopies(source, destination);
  if (copies.length > 0 && (yield* directoryTreeIsCopyable(source, destination, path))) {
    for (const copy of copies) {
      const copied = yield* runExec(
        copy.command,
        copy.args,
        source,
        destination,
        "copy",
        copy.acceptStatus,
      ).pipe(
        Effect.asVoid,
        // matchCauseEffect does not observe an external interrupt.
        Effect.onInterrupt(() => removePartial(destination, fs, path)),
        Effect.matchCauseEffect({
          onSuccess: () => Effect.succeed("copied" as const),
          onFailure: (cause) =>
            removePartial(destination, fs, path).pipe(
              Effect.flatMap(() => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
                const outcome = isUsageFailure(cause) ? "usage" : "failed";
                return Effect.succeed(outcome);
              }),
            ),
        }),
      );
      if (copied === "copied") return;
      if (copied === "failed") break;
    }
  }
  yield* validateTree(source, destination, fs, path);
  return yield* copyTree(source, destination, fs, path);
});

const runExec = (
  command: string,
  args: ReadonlyArray<string>,
  source: string,
  destination: string,
  operation: string,
  acceptStatus: (status: number) => boolean = () => false,
): Effect.Effect<string, DirectoryCopyError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(command, [...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(Effect.mapError((cause) => errorFor(operation, source, destination, cause)));
      const [text, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: 3 },
      ).pipe(Effect.mapError((cause) => errorFor(operation, source, destination, cause)));
      const status = Number(exitCode);
      if (status !== 0 && !acceptStatus(status)) {
        return yield* errorFor(operation, source, destination, new Error(stderr));
      }
      return text;
    }),
  );

const directoryTreeIsCopyable = (
  source: string,
  destination: string,
  path: Path.Path,
): Effect.Effect<boolean, DirectoryCopyError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const stats = yield* inspect(source, destination);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return yield* (
      process.platform === "win32"
        ? scanUnsupported(source, destination, path)
        : findUnsupportedEntry(source, destination)
    ).pipe(
      Effect.matchCauseEffect({
        onSuccess: (found) => Effect.succeed(!found),
        onFailure: (cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(false),
      }),
    );
  });

const findUnsupportedEntry = (
  source: string,
  destination: string,
): Effect.Effect<boolean, DirectoryCopyError, ChildProcessSpawner.ChildProcessSpawner> =>
  runExec(
    "find",
    [
      source,
      "(",
      "-type",
      "l",
      "-o",
      "-type",
      "p",
      "-o",
      "-type",
      "s",
      "-o",
      "-type",
      "b",
      "-o",
      "-type",
      "c",
      ")",
      "-print",
      "-quit",
    ],
    source,
    destination,
    "validate",
  ).pipe(Effect.map((stdout) => stdout.trim().length > 0));

// Windows find is a content search, so the unsupported-entry scan stays in process.
const scanUnsupported = (
  source: string,
  destination: string,
  path: Path.Path,
): Effect.Effect<boolean, DirectoryCopyError> =>
  Effect.gen(function* () {
    const pending = [source];
    let current = pending.pop();
    while (current !== undefined) {
      const directory = current;
      const entries = yield* Effect.tryPromise({
        try: () => readdir(directory, { withFileTypes: true }),
        catch: (cause) => errorFor("validate", source, destination, cause),
      });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return true;
        if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      }
      current = pending.pop();
    }
    return false;
  });

interface HostCopy {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly acceptStatus: (status: number) => boolean;
}

const rejectStatus = (_status: number) => false;

// A preserved directory mode can omit user write, and unlink then fails with EACCES.
const grantDirectoryWrite = (
  directory: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<void, DirectoryCopyError> =>
  Effect.gen(function* () {
    const info = yield* fs
      .stat(directory)
      .pipe(Effect.mapError((cause) => errorFor("chmod", directory, directory, cause)));
    yield* fs
      .chmod(directory, (Number(info.mode) | 0o700) & 0o7777)
      .pipe(Effect.mapError((cause) => errorFor("chmod", directory, directory, cause)));
    if (info.type !== "Directory") return;
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.mapError((cause) => errorFor("readDirectory", directory, directory, cause)));
    for (const name of names) {
      const child = path.join(directory, name);
      const childInfo = yield* fs
        .stat(child)
        .pipe(Effect.mapError((cause) => errorFor("chmod", directory, child, cause)));
      if (childInfo.type === "Directory") yield* grantDirectoryWrite(child, fs, path);
    }
  });

// Deletion has to finish after a cancel. Stopping during chmod leaves the partial tree,
// including directories whose mode then rejects removal.
const removePartial = (
  destination: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<void, DirectoryCopyError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (
        !(yield* fs
          .exists(destination)
          .pipe(Effect.mapError((cause) => errorFor("remove", destination, destination, cause))))
      )
        return;
      yield* grantDirectoryWrite(destination, fs, path);
      yield* fs
        .remove(destination, { recursive: true, force: true })
        .pipe(Effect.mapError((cause) => errorFor("remove", destination, destination, cause)));
    }),
  );

const isUsageError = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null || !("message" in cause)) return false;
  const message = cause.message;
  return (
    typeof message === "string" &&
    /unrecognized option|invalid option|unknown option|illegal option/iu.test(message)
  );
};

const isUsageFailure = (cause: Cause.Cause<DirectoryCopyError>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) => isUsageError(error.cause),
  });

// One process copies the tree. macOS clones, and Linux reflinks when the filesystem can.
const hostCopies = (source: string, destination: string): ReadonlyArray<HostCopy> => {
  switch (process.platform) {
    case "darwin":
      return [{ command: "cp", args: ["-cRp", source, destination], acceptStatus: rejectStatus }];
    case "linux":
      return [
        {
          command: "cp",
          args: ["-R", "--preserve=mode", "--reflink=auto", "--", source, destination],
          acceptStatus: rejectStatus,
        },
        // BusyBox cp has no reflink flag. -Rp still copies the tree in one process.
        { command: "cp", args: ["-Rp", source, destination], acceptStatus: rejectStatus },
      ];
    case "win32":
      // Robocopy's exit status is a bit field. Values below 8 mean the copy succeeded.
      return [
        {
          command: "robocopy",
          args: [
            source,
            destination,
            "/E",
            "/COPY:DAT",
            "/DCOPY:DAT",
            "/MT:8",
            "/R:0",
            "/W:0",
            "/NFL",
            "/NDL",
            "/NJH",
            "/NJS",
            "/NP",
          ],
          acceptStatus: (status) => status < 8,
        },
      ];
    default:
      return [];
  }
};

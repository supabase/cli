// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no lstat or typed directory listing.
import { lstat, readdir } from "node:fs/promises";
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

const isNotFound = (cause: unknown): boolean =>
  Schema.is(NativeFileError)(cause)
    ? isNotFound(cause.cause)
    : typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

// FileSystem does not expose lstat, which link detection needs.
const nativeLstat = (target: string): Effect.Effect<NativeStats, NativeFileError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => lstat(target),
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

/** Copies a plain directory tree with one host copy process; links and special files fail. */
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
  const stats = yield* inspect(source, destination);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    return yield* errorFor("validate", source, destination, "not a plain directory");
  // cp and robocopy keep or follow links, so only a plain tree reaches them.
  const unsupported = yield* process.platform === "win32"
    ? scanUnsupported(source, destination, path)
    : findUnsupportedEntry(source, destination);
  if (unsupported) return yield* errorFor("validate", source, destination, "link or special file");
  let failure: DirectoryCopyError | undefined;
  for (const copy of hostCopies(source, destination)) {
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
        onSuccess: () => Effect.succeedNone,
        onFailure: (cause) =>
          removePartial(destination, fs, path).pipe(
            Effect.flatMap(() =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => Effect.failCause(cause),
                onSome: (error) => Effect.succeedSome(error),
              }),
            ),
          ),
      }),
    );
    if (Option.isNone(copied)) return;
    failure = copied.value;
    if (!isUsageError(failure.cause)) break;
  }
  return yield* failure ?? errorFor("copy", source, destination, "no host copy tool");
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
        if (entry.isDirectory()) {
          const entryPath = path.join(directory, entry.name);
          const stats = yield* nativeLstat(entryPath).pipe(
            Effect.mapError((cause) => errorFor("validate", source, destination, cause)),
          );
          if (stats.isSymbolicLink()) return true;
          pending.push(entryPath);
        }
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
            "/XJD",
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

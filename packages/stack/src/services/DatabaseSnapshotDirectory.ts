import { Crypto, Data, Effect, FileSystem, Path, Schema, Stream } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Node's forced reflink flag has no Effect equivalent.
import { copyFile, lstat } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Windows cannot rename over an existing empty directory.
import { rmdir } from "node:fs/promises";
import { constants } from "node:fs"; // oxlint-disable-line effecttsgo/node-builtin-import -- CoW flags are unavailable through Effect's filesystem abstraction.
import { postgresVersion, resolveArtifact } from "../Artifacts.ts";
import type { DatabaseRuntime } from "./Database.ts";
import { makeContainerRuntime, type ContainerRuntime } from "../runtime/Container.ts";

export const SnapshotDescriptor = Schema.Struct({
  format: Schema.Literal("supabase-database-snapshot-v1"),
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  platform: Schema.String,
  arch: Schema.String,
  profile: Schema.Literal("supabase"),
});
export interface SnapshotDescriptor extends Schema.Schema.Type<typeof SnapshotDescriptor> {}

export class DatabaseSnapshotError extends Data.TaggedError("DatabaseSnapshotError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DatabaseSnapshot {
  readonly descriptor: SnapshotDescriptor;
  readonly destination: string;
}

const ReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  profile: Schema.Literal("supabase"),
});

const errorFor = (operation: string, cause: unknown) =>
  cause instanceof DatabaseSnapshotError
    ? cause
    : new DatabaseSnapshotError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const safeRelative = (name: string) => {
  if (name.startsWith("/") || name.includes("\\")) return false;
  const parts = name.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
};

export type DirectorySnapshotCopyMode = "clone" | "copy";

export interface DirectorySnapshotCopyResult {
  readonly files: number;
  readonly clonedFiles: number;
  readonly fallbackFiles: number;
}

const cloneUnsupported = (cause: unknown) => {
  const raw = cause instanceof DatabaseSnapshotError ? cause.cause : cause;
  if (!(raw instanceof Error) || !("code" in raw)) return false;
  return ["EOPNOTSUPP", "ENOTSUP", "EXDEV", "EINVAL", "ENOSYS"].includes(String(raw.code));
};

/** Copies a directory tree, attempting filesystem CoW per file and reporting fallback honestly. */
export const copyDirectorySnapshot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  source: string,
  destination: string,
  mode: DirectorySnapshotCopyMode,
): Effect.Effect<DirectorySnapshotCopyResult, DatabaseSnapshotError> => {
  return Effect.suspend(() => {
    const result = { files: 0, clonedFiles: 0, fallbackFiles: 0 };
    const leaf = <A>(operation: string, task: () => Promise<A>) =>
      Effect.tryPromise({ try: task, catch: (cause) => errorFor(operation, cause) });
    const copyTree = (from: string, to: string): Effect.Effect<void, DatabaseSnapshotError> =>
      Effect.gen(function* () {
        const info = yield* leaf("validate", () => lstat(from));
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
          return yield* errorFor("validate", `Unsupported snapshot entry: ${from}`);
        if (info.isDirectory()) {
          yield* fs
            .makeDirectory(to, { recursive: true, mode: info.mode & 0o7777 })
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          const entries = yield* fs
            .readDirectory(from)
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          yield* Effect.forEach(entries, (entry) =>
            copyTree(path.join(from, entry), path.join(to, entry)),
          );
          yield* fs
            .chmod(to, info.mode & 0o7777)
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          return;
        }
        yield* fs
          .makeDirectory(path.dirname(to), { recursive: true })
          .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
        if (mode === "clone") {
          yield* leaf("clone", () => copyFile(from, to, constants.COPYFILE_FICLONE_FORCE)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                result.clonedFiles += 1;
              }),
            ),
            Effect.catch((cause) =>
              cloneUnsupported(cause)
                ? leaf("copy", () => copyFile(from, to)).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        result.fallbackFiles += 1;
                      }),
                    ),
                  )
                : Effect.fail(cause),
            ),
          );
        } else {
          yield* fs.stream(from).pipe(
            Stream.run(fs.sink(to)),
            Effect.mapError((cause) => errorFor("copy", cause)),
            Effect.tap(() =>
              Effect.sync(() => {
                result.fallbackFiles += 1;
              }),
            ),
          );
        }
        yield* fs
          .chmod(to, info.mode & 0o7777)
          .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
        result.files += 1;
      });
    return copyTree(source, path.join(destination, path.basename(source))).pipe(Effect.as(result));
  });
};

export const makeDatabaseSnapshots = Effect.fn("DatabaseSnapshot.make")(function* (options: {
  readonly instanceRoot: string;
  readonly runtime: DatabaseRuntime;
  readonly version: string;
  readonly stackId: string;
  readonly instanceId: string;
  readonly directoryCopyMode?: DirectorySnapshotCopyMode;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const version = postgresVersion(options.version);
  const container: ContainerRuntime | undefined =
    options.runtime === "native"
      ? undefined
      : yield* makeContainerRuntime({ engine: options.runtime });
  const helperImage =
    options.runtime === "native"
      ? undefined
      : yield* resolveArtifact({ service: "database", version }).pipe(
          Effect.mapError((cause) => errorFor("artifact", cause)),
        );
  const descriptor: SnapshotDescriptor = {
    format: "supabase-database-snapshot-v1",
    version,
    runtime: options.runtime,
    platform: process.platform,
    arch: process.arch,
    profile: "supabase",
  };

  const nativeCopyDirectory = Effect.fn("DatabaseSnapshotDirectory.copyDirectory")(
    (source: string, destination: string, mode: DirectorySnapshotCopyMode = "clone") =>
      copyDirectorySnapshot(fs, path, source, destination, mode).pipe(
        Effect.mapError((cause) => errorFor("stage", cause)),
      ),
  );

  const nativeLstat = (target: string) =>
    Effect.tryPromise({
      try: () => lstat(target),
      catch: (cause) => errorFor("validate", cause),
    });

  type ToolMount = {
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
  };
  const toolCommand = Effect.fn("DatabaseSnapshot.toolCommand")(
    (
      stage: string,
      script: string,
      writableInstance = false,
      mounts?: ReadonlyArray<ToolMount>,
      onFailure?: (code: number, stderr: string) => DatabaseSnapshotError,
    ) =>
      Effect.gen(function* () {
        if (container === undefined || helperImage === undefined)
          return yield* errorFor("container", "Container runtime missing");
        yield* container
          .prepare(helperImage.image)
          .pipe(Effect.mapError((cause) => errorFor("container", cause)));
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const acquire = container
              .launchTool({
                image: helperImage.image,
                stackId: options.stackId,
                instanceId: options.instanceId,
                entrypoint: "/usr/bin/busybox",
                env: {},
                mounts: mounts ?? [
                  {
                    source: options.instanceRoot,
                    target: "/instance",
                    readOnly: !writableInstance,
                  },
                  { source: stage, target: "/stage", readOnly: false },
                ],
                args: ["sh", "-c", script],
              })
              .pipe(
                Effect.catchTag("ContainerLaunchError", ({ failure, process: partial }) =>
                  partial.stop.pipe(
                    Effect.andThen(partial.remove),
                    Effect.mapError((cause) => errorFor("container-cleanup", cause)),
                    Effect.andThen(Effect.fail(errorFor("container", failure))),
                  ),
                ),
              );
            return yield* Effect.acquireUseRelease(
              acquire,
              (owned) =>
                Effect.all(
                  [
                    owned.stdout.pipe(
                      Stream.decodeText,
                      Stream.runFold(
                        () => "",
                        (all, chunk) => `${all}${chunk}`.slice(0, 65536),
                      ),
                    ),
                    owned.stderr.pipe(
                      Stream.decodeText,
                      Stream.runFold(
                        () => "",
                        (all, chunk) => `${all}${chunk}`.slice(0, 65536),
                      ),
                    ),
                    owned.exitCode,
                  ],
                  { concurrency: "unbounded" },
                ).pipe(
                  Effect.flatMap(([stdout, stderr, code]) =>
                    Number(code) === 0
                      ? Effect.succeed(stdout)
                      : Effect.fail(
                          onFailure?.(Number(code), stderr.trim()) ??
                            errorFor(
                              "container",
                              stderr.trim() || `Helper exited with ${String(code)}`,
                            ),
                        ),
                  ),
                ),
              (owned) =>
                owned.stop.pipe(
                  Effect.andThen(owned.remove),
                  Effect.mapError((cause) => errorFor("container", cause)),
                ),
            );
          }),
        );
      }).pipe(Effect.mapError((cause) => errorFor("container", cause))),
  );

  const cleanupStage = Effect.fn("DatabaseSnapshot.cleanupStage")((directory: string) =>
    Effect.gen(function* () {
      if (options.runtime !== "native" && (yield* fs.exists(path.join(directory, "extracted")))) {
        yield* toolCommand(directory, "/usr/bin/busybox rm -rf /stage/extracted");
      }
      yield* fs.remove(directory, { recursive: true, force: true });
    }).pipe(Effect.mapError((cause) => errorFor("cleanup", cause))),
  );

  const readReady = Effect.fn("DatabaseSnapshot.readReady")(() =>
    Effect.gen(function* () {
      const marker = yield* fs.readFileString(
        path.join(options.instanceRoot, ".supabase-database-ready.json"),
      );
      return yield* Schema.decodeEffect(Schema.fromJsonString(ReadyMarker))(marker);
    }).pipe(Effect.mapError((cause) => errorFor("ready", cause))),
  );

  const verifyData = Effect.fn("DatabaseSnapshot.verifyData")(function* () {
    const data = path.join(options.instanceRoot, "data");
    if (options.runtime === "native") {
      if (!(yield* fs.exists(data).pipe(Effect.mapError((cause) => errorFor("data", cause)))))
        return yield* errorFor("data", "Database data directory is absent");
      if (
        yield* fs
          .exists(path.join(data, "postmaster.pid"))
          .pipe(Effect.mapError((cause) => errorFor("data", cause)))
      )
        return yield* errorFor("data", "Database must be stopped before snapshotting");
      if (
        !(yield* fs
          .exists(path.join(data, "PG_VERSION"))
          .pipe(Effect.mapError((cause) => errorFor("data", cause))))
      )
        return yield* errorFor("data", "Database data directory is not initialized");
    } else {
      yield* toolCommand(
        options.instanceRoot,
        "test -d /instance/data && test -f /instance/data/PG_VERSION && test ! -e /instance/data/postmaster.pid",
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof DatabaseSnapshotError && cause.operation === "container"
            ? new DatabaseSnapshotError({
                operation: "data",
                message: cause.message,
                cause,
              })
            : cause,
        ),
      );
    }
    return data;
  });

  const exportSnapshot = Effect.fn("DatabaseSnapshot.export")(function* ({
    destination,
  }: {
    readonly destination: string;
  }) {
    if (options.runtime !== "native")
      return yield* errorFor("runtime", "Directory snapshots require the native runtime");
    const ready = yield* readReady();
    if (
      ready.version !== version ||
      ready.runtime !== options.runtime ||
      ready.profile !== "supabase"
    )
      return yield* errorFor("ready", "Database readiness marker does not match the instance");
    yield* verifyData();
    if (yield* fs.exists(destination).pipe(Effect.mapError((cause) => errorFor("export", cause))))
      return yield* errorFor("export", "Destination already exists");
    const parent = path.dirname(destination);
    const stageToken = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => errorFor("export", cause)),
    );
    return yield* Effect.acquireUseRelease(
      fs
        .makeTempDirectory({ directory: parent, prefix: `.supabase-snapshot-${stageToken}-` })
        .pipe(Effect.mapError((cause) => errorFor("export", cause))),
      (stage) =>
        Effect.gen(function* () {
          const metadata = path.join(stage, "metadata");
          yield* fs
            .makeDirectory(metadata, { recursive: true })
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotDescriptor))(
            descriptor,
          ).pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
          yield* fs
            .writeFileString(path.join(metadata, "descriptor.json"), encoded, { mode: 0o600 })
            .pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
          const archive = path.join(stage, "snapshot");
          yield* fs
            .makeDirectory(archive, { recursive: true })
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          yield* nativeCopyDirectory(
            path.join(options.instanceRoot, "data"),
            archive,
            options.directoryCopyMode,
          );
          yield* fs
            .rename(metadata, path.join(archive, "metadata"))
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          yield* fs
            .rename(archive, destination)
            .pipe(Effect.mapError((cause) => errorFor("publish", cause)));
          return { descriptor, destination };
        }),
      cleanupStage,
    );
  });

  const restoreSnapshot = Effect.fn("DatabaseSnapshot.restore")(function* ({
    source,
  }: {
    readonly source: string;
  }) {
    if (options.runtime !== "native")
      return yield* errorFor("runtime", "Directory snapshots require the native runtime");
    const data = path.join(options.instanceRoot, "data");
    const dataExists = yield* fs
      .exists(data)
      .pipe(Effect.mapError((cause) => errorFor("restore", cause)));
    if (
      dataExists &&
      (yield* fs.readDirectory(data).pipe(Effect.mapError((cause) => errorFor("restore", cause))))
        .length > 0
    )
      return yield* errorFor("restore", "Restore target data directory must be empty");
    const sourceInfo = yield* nativeLstat(source);
    if (!sourceInfo.isDirectory())
      return yield* errorFor("restore", "Directory snapshot source is not a directory");
    const stageToken = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => errorFor("restore", cause)),
    );
    return yield* Effect.acquireUseRelease(
      fs
        .makeTempDirectory({
          directory: options.instanceRoot,
          prefix: `.supabase-restore-${stageToken}-`,
        })
        .pipe(Effect.mapError((cause) => errorFor("restore", cause))),
      (stage) =>
        Effect.gen(function* () {
          const sourceName = path.basename(source);
          yield* nativeCopyDirectory(source, stage, options.directoryCopyMode);
          const stagedSource = path.join(stage, sourceName);
          const validateTree = (
            root: string,
            prefix: string,
          ): Effect.Effect<void, DatabaseSnapshotError> =>
            Effect.gen(function* () {
              const entries = yield* fs
                .readDirectory(root)
                .pipe(Effect.mapError((cause) => errorFor("validate", cause)));
              for (const entry of entries) {
                const relative = prefix.length === 0 ? entry : `${prefix}/${entry}`;
                if (
                  !safeRelative(relative) ||
                  !(
                    relative === "data" ||
                    relative.startsWith("data/") ||
                    relative === "metadata" ||
                    relative === "metadata/descriptor.json"
                  )
                )
                  return yield* errorFor("validate", `Unsafe snapshot member: ${relative}`);
                const target = path.join(root, entry);
                const info = yield* nativeLstat(target);
                if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
                  return yield* errorFor("validate", `Unsafe snapshot member: ${relative}`);
                if (info.isDirectory()) yield* validateTree(target, relative);
              }
            });
          yield* validateTree(stagedSource, "");
          const descriptorText = yield* fs
            .readFileString(path.join(stagedSource, "metadata", "descriptor.json"))
            .pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
          const incoming = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotDescriptor))(
            descriptorText,
          ).pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
          if (
            incoming.format !== descriptor.format ||
            incoming.version !== descriptor.version ||
            incoming.runtime !== descriptor.runtime ||
            incoming.platform !== descriptor.platform ||
            incoming.arch !== descriptor.arch ||
            incoming.profile !== descriptor.profile
          )
            return yield* errorFor(
              "descriptor",
              "Snapshot is incompatible with this database instance",
            );
          const restoredVersion = path.join(stagedSource, "data", "PG_VERSION");
          if (
            !(yield* fs
              .exists(restoredVersion)
              .pipe(Effect.mapError((cause) => errorFor("validate", cause))))
          )
            return yield* errorFor("validate", "Snapshot data is not initialized");
          const actualVersion = yield* fs
            .readFileString(restoredVersion)
            .pipe(Effect.mapError((cause) => errorFor("validate", cause)));
          if (actualVersion.trim() !== version.split(".")[0])
            return yield* errorFor(
              "validate",
              "Snapshot data has an incompatible PostgreSQL major version",
            );
          if (dataExists)
            yield* Effect.tryPromise({
              try: () => rmdir(data),
              catch: (cause) => errorFor("publish", cause),
            });
          yield* fs
            .rename(path.join(stagedSource, "data"), data)
            .pipe(Effect.mapError((cause) => errorFor("publish", cause)));
          const marker = yield* Schema.encodeEffect(Schema.fromJsonString(ReadyMarker))({
            version,
            runtime: options.runtime,
            profile: "supabase",
          }).pipe(Effect.mapError((cause) => errorFor("ready", cause)));
          yield* fs
            .writeFileString(
              path.join(options.instanceRoot, ".supabase-database-ready.json"),
              marker,
              { mode: 0o600 },
            )
            .pipe(
              Effect.mapError((cause) => errorFor("ready", cause)),
              Effect.catch((failure: DatabaseSnapshotError) =>
                fs.remove(data, { recursive: true, force: true }).pipe(
                  Effect.mapError((cause) => errorFor("cleanup", cause)),
                  Effect.andThen(Effect.fail(failure)),
                ),
              ),
            );
          return { descriptor: incoming, destination: source };
        }),
      cleanupStage,
    );
  });
  return { exportSnapshot, restoreSnapshot };
});

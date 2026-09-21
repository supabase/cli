import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Crypto, Data, Effect, FileSystem, Path, Schema, Stream } from "effect";
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

export const makeDatabaseSnapshots = Effect.fn("DatabaseSnapshot.make")(function* (options: {
  readonly instanceRoot: string;
  readonly runtime: DatabaseRuntime;
  readonly version: string;
  readonly stackId: string;
  readonly instanceId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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

  const commandRaw = Effect.fn("DatabaseSnapshot.command")(function* (args: ReadonlyArray<string>) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("tar", args, { stdin: "ignore" }));
        const [stdout, stderr, code] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText,
              Stream.runFold(
                () => "",
                (all, chunk) => `${all}${chunk}`.slice(0, 65536),
              ),
            ),
            child.stderr.pipe(
              Stream.decodeText,
              Stream.runFold(
                () => "",
                (all, chunk) => `${all}${chunk}`.slice(0, 65536),
              ),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0)
          return yield* errorFor("tar", stderr.trim() || `tar exited with ${String(code)}`);
        return stdout;
      }),
    );
  });
  const command = (args: ReadonlyArray<string>) =>
    commandRaw(args).pipe(Effect.mapError((cause) => errorFor("tar", cause)));

  const commandLines = Effect.fn("DatabaseSnapshot.commandLines")(
    (
      args: ReadonlyArray<string>,
      onLine: (line: string) => Effect.Effect<void, DatabaseSnapshotError>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(ChildProcess.make("tar", args, { stdin: "ignore" }));
          const [, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runForEach(onLine)),
              child.stderr.pipe(
                Stream.decodeText,
                Stream.runFold(
                  () => "",
                  (all, chunk) => `${all}${chunk}`.slice(0, 65536),
                ),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (Number(code) !== 0)
            return yield* errorFor("tar", stderr.trim() || `tar exited with ${String(code)}`);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof DatabaseSnapshotError ? cause : errorFor("tar", cause),
        ),
      ),
  );

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
          const archive = path.join(stage, "snapshot.tar");
          if (options.runtime === "native")
            yield* command([
              "-cf",
              archive,
              "-C",
              options.instanceRoot,
              "data",
              "-C",
              stage,
              "metadata",
            ]);
          else {
            yield* fs
              .writeFileString(archive, "", { mode: 0o600 })
              .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
            yield* toolCommand(
              stage,
              "/usr/bin/busybox tar -cf /snapshot/snapshot.tar -C /snapshot data metadata",
              false,
              [
                { source: stage, target: "/snapshot", readOnly: false },
                {
                  source: path.join(options.instanceRoot, "data"),
                  target: "/snapshot/data",
                  readOnly: true,
                },
              ],
            );
          }
          yield* fs
            .link(archive, destination)
            .pipe(Effect.mapError((cause) => errorFor("publish", cause)));
          yield* fs.remove(archive).pipe(Effect.mapError((cause) => errorFor("publish", cause)));
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
    const data = path.join(options.instanceRoot, "data");
    const dataExists = yield* fs
      .exists(data)
      .pipe(Effect.mapError((cause) => errorFor("restore", cause)));
    if (options.runtime === "native") {
      if (
        dataExists &&
        (yield* fs.readDirectory(data).pipe(Effect.mapError((cause) => errorFor("restore", cause))))
          .length > 0
      )
        return yield* errorFor("restore", "Restore target data directory must be empty");
    }
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
          const archive = path.join(stage, "source.tar");
          yield* fs
            .copyFile(source, archive)
            .pipe(Effect.mapError((cause) => errorFor("stage", cause)));
          const descriptorPath = path.join(stage, "descriptor.json");
          const namesPath = path.join(stage, "names");
          const typesPath = path.join(stage, "types");
          let descriptorText: string;
          if (options.runtime === "native")
            descriptorText = yield* command(["-xOf", archive, "metadata/descriptor.json"]);
          else {
            yield* Effect.all(
              [descriptorPath, namesPath, typesPath].map((file) =>
                fs
                  .writeFileString(file, "", { mode: 0o600 })
                  .pipe(Effect.mapError((cause) => errorFor("stage", cause))),
              ),
            );
            yield* toolCommand(
              stage,
              'set -eo pipefail; if test -e /instance/data && test -n "$(/usr/bin/busybox ls -A /instance/data)"; then echo target data directory is not empty >&2; exit 42; fi; /usr/bin/busybox tar -xOf /stage/source.tar metadata/descriptor.json | /usr/bin/busybox head -c 65537 > /stage/descriptor.json; if test "$(/usr/bin/busybox wc -c < /stage/descriptor.json)" -ge 65537; then echo snapshot descriptor exceeds 64 KiB >&2; exit 44; fi; /usr/bin/busybox tar -tf /stage/source.tar > /stage/names; /usr/bin/busybox tar -tvf /stage/source.tar > /stage/types',
              false,
              undefined,
              (code, stderr) =>
                code === 42
                  ? errorFor("restore", stderr || "Restore target data directory must be empty")
                  : code === 44
                    ? errorFor("descriptor", stderr || "Snapshot descriptor exceeds 64 KiB")
                    : errorFor("container", stderr || `Helper exited with ${String(code)}`),
            );
            if (
              (yield* fs
                .stat(descriptorPath)
                .pipe(Effect.mapError((cause) => errorFor("descriptor", cause)))).size > 65536n
            )
              return yield* errorFor("descriptor", "Snapshot descriptor exceeds 64 KiB");
            descriptorText = yield* fs
              .stream(descriptorPath, { bytesToRead: 65536, chunkSize: 65536 })
              .pipe(
                Stream.decodeText,
                Stream.runFold(
                  () => "",
                  (all, chunk) => `${all}${chunk}`,
                ),
                Effect.mapError((cause) => errorFor("descriptor", cause)),
              );
          }
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
          const validateName = (line: string) => {
            const name = line.replace(/\/$/u, "");
            return name.length === 0 ||
              ((["data", "metadata", "metadata/descriptor.json"].includes(name) ||
                name.startsWith("data/")) &&
                safeRelative(name))
              ? Effect.void
              : Effect.fail(errorFor("validate", `Unsafe snapshot member: ${name}`));
          };
          const validateListing = (
            listing: string,
            validator: (line: string) => Effect.Effect<void, DatabaseSnapshotError>,
          ) =>
            fs.stream(listing).pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runForEach(validator),
              Effect.mapError((cause) =>
                cause instanceof DatabaseSnapshotError ? cause : errorFor("validate", cause),
              ),
            );
          if (options.runtime === "native") yield* commandLines(["-tf", archive], validateName);
          else yield* validateListing(namesPath, validateName);
          const validateType = (line: string) =>
            line.length === 0 || line[0] === "-" || line[0] === "d"
              ? Effect.void
              : Effect.fail(errorFor("validate", "Snapshot contains a non-regular member"));
          if (options.runtime === "native") yield* commandLines(["-tvf", archive], validateType);
          else yield* validateListing(typesPath, validateType);
          const extracted = path.join(stage, "extracted");
          yield* fs
            .makeDirectory(extracted, { recursive: true })
            .pipe(Effect.mapError((cause) => errorFor("extract", cause)));
          if (options.runtime === "native") yield* command(["-xf", archive, "-C", extracted]);
          const expectedMajor = version.split(".")[0];
          if (options.runtime === "native") {
            const restoredVersion = path.join(extracted, "data", "PG_VERSION");
            if (
              !(yield* fs
                .exists(restoredVersion)
                .pipe(Effect.mapError((cause) => errorFor("validate", cause))))
            )
              return yield* errorFor("validate", "Snapshot data is not initialized");
            const actualVersion = yield* fs
              .readFileString(restoredVersion)
              .pipe(Effect.mapError((cause) => errorFor("validate", cause)));
            if (actualVersion.trim() !== expectedMajor)
              return yield* errorFor(
                "validate",
                "Snapshot data has an incompatible PostgreSQL major version",
              );
          } else {
            const stageName = path.basename(stage);
            yield* toolCommand(
              stage,
              `set -e; trap '/usr/bin/busybox rm -rf /stage/extracted' EXIT; /usr/bin/busybox tar -xf /stage/source.tar -C /stage/extracted; if test ! -f /stage/extracted/data/PG_VERSION; then echo Snapshot data is not initialized >&2; exit 43; fi; if test "$(/usr/bin/busybox cat /stage/extracted/data/PG_VERSION)" != "${expectedMajor}"; then echo Snapshot data has an incompatible PostgreSQL major version >&2; exit 43; fi; /usr/bin/busybox chown -R 100:101 /instance/${stageName}/extracted/data; /usr/bin/busybox chmod 700 /instance/${stageName}/extracted/data; if test -e /instance/data; then /usr/bin/busybox rmdir /instance/data; fi; /usr/bin/busybox mv /instance/${stageName}/extracted/data /instance/data; /usr/bin/busybox rm -rf /stage/extracted`,
              true,
              undefined,
              (code, stderr) =>
                code === 43
                  ? errorFor(
                      "validate",
                      stderr ||
                        "Snapshot data is missing or has an incompatible PostgreSQL major version",
                    )
                  : errorFor("container", stderr || `Helper exited with ${String(code)}`),
            );
          }
          if (options.runtime === "native") {
            yield* fs
              .rename(path.join(extracted, "data"), data)
              .pipe(Effect.mapError((cause) => errorFor("publish", cause)));
          }
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
              Effect.catch((failure: DatabaseSnapshotError) => {
                const cleanup =
                  options.runtime === "native"
                    ? fs
                        .remove(data, { recursive: true, force: true })
                        .pipe(Effect.mapError((cause) => errorFor("cleanup", cause)))
                    : toolCommand(
                        options.instanceRoot,
                        "/usr/bin/busybox rm -rf /instance/data",
                        true,
                      ).pipe(Effect.asVoid);
                return cleanup.pipe(Effect.andThen(Effect.fail(failure)));
              }),
            );

          return { descriptor: incoming, destination: source };
        }),
      cleanupStage,
    );
  });

  return { exportSnapshot, restoreSnapshot };
});

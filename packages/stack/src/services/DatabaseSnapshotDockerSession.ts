import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Crypto, Effect, FileSystem, Path, Schema, Scope, Stream } from "effect";
import { postgresVersion, resolveArtifact } from "../Artifacts.ts";
import type { DatabaseRuntime } from "./Database.ts";
import {
  DatabaseSnapshotError,
  SnapshotDescriptor,
  type DatabaseSnapshot,
} from "./DatabaseSnapshot.ts";
import {
  makeContainerRuntime,
  type ContainerProcess,
  type ContainerRuntime,
} from "../runtime/Container.ts";

const ReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  profile: Schema.Literal("supabase"),
});

type SnapshotOptions = {
  readonly instanceRoot: string;
  readonly runtime: DatabaseRuntime;
  readonly version: string;
  readonly stackId: string;
  readonly instanceId: string;
};

type PhaseEvent = {
  readonly phase: string;
  readonly milliseconds: number;
};

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

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export interface DockerSnapshotSession {
  readonly forInstance: (options: SnapshotOptions) => Effect.Effect<
    {
      readonly exportSnapshot: (input: {
        readonly destination: string;
      }) => Effect.Effect<DatabaseSnapshot, DatabaseSnapshotError, Scope.Scope>;
      readonly restoreSnapshot: (input: {
        readonly source: string;
      }) => Effect.Effect<DatabaseSnapshot, DatabaseSnapshotError, Scope.Scope>;
    },
    DatabaseSnapshotError,
    Scope.Scope
  >;
}

export const makeDockerSnapshotSession = Effect.fn("DatabaseSnapshotDockerSession.make")(
  (options: {
    readonly root: string;
    readonly reuse: boolean;
    readonly onPhase?: (event: PhaseEvent) => void;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const root = yield* Effect.try({
        try: () => path.resolve(options.root),
        catch: (cause) => errorFor("path", cause),
      });

      const phase = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          const started = performance.now();
          return effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                try {
                  options.onPhase?.({ phase: name, milliseconds: performance.now() - started });
                } catch {
                  // Instrumentation must not alter snapshot behavior.
                }
              }),
            ),
          );
        });

      const contained = (candidate: string, label: string) =>
        Effect.try({
          try: () => {
            const absolute = path.resolve(candidate);
            const relativePath = path.relative(root, absolute);
            if (
              relativePath !== "" &&
              (relativePath === ".." ||
                relativePath.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relativePath))
            )
              throw new Error(`${label} must be inside the session root`);
            return absolute;
          },
          catch: (cause) => errorFor("path", cause),
        });

      const workspacePath = (absolute: string) => {
        const relativePath = path.relative(root, absolute);
        return shellQuote(relativePath === "" ? "/workspace" : `/workspace/${relativePath}`);
      };

      const sharedHelpers = new Map<string, ContainerProcess>();

      const exec = Effect.fn("DatabaseSnapshotDockerSession.exec")(
        (
          container: ContainerProcess,
          engine: "docker" | "podman",
          script: string,
          operation: string,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(
                  engine,
                  ["exec", container.id, "/usr/bin/busybox", "sh", "-c", script],
                  { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
                ),
              );
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
                return yield* errorFor(
                  operation,
                  stderr.trim() || `Container exec exited with ${String(code)}`,
                );
              return stdout;
            }),
          ).pipe(Effect.mapError((cause) => errorFor(operation, cause))),
      );

      const forInstance = Effect.fn("DatabaseSnapshotDockerSession.forInstance")(
        (instance: SnapshotOptions) =>
          Effect.gen(function* () {
            const engine =
              instance.runtime === "native"
                ? yield* errorFor("runtime", "Docker snapshot session requires a container runtime")
                : instance.runtime;
            const instanceRoot = yield* contained(instance.instanceRoot, "instanceRoot");
            const version = postgresVersion(instance.version);
            const descriptor: SnapshotDescriptor = {
              format: "supabase-database-snapshot-v1" as const,
              version,
              runtime: engine,
              platform: process.platform,
              arch: process.arch,
              profile: "supabase" as const,
            };
            const container: ContainerRuntime = yield* makeContainerRuntime({ engine }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );
            const helperImage = yield* resolveArtifact({ service: "database", version }).pipe(
              Effect.mapError((cause) => errorFor("artifact", cause)),
            );
            const launchHelper = container
              .launch({
                image: helperImage.image,
                stackId: instance.stackId,
                instanceId: instance.instanceId,
                entrypoint: "/usr/bin/busybox",
                env: {},
                mounts: [{ source: root, target: "/workspace", readOnly: false }],
                args: ["sh", "-c", "trap 'exit 0' TERM INT; /usr/bin/busybox sleep 3600 & wait"],
              })
              .pipe(Effect.mapError((cause) => errorFor("container", cause)));
            const stopAndRemove = (helper: ContainerProcess) =>
              helper.stop.pipe(
                Effect.andThen(helper.remove),
                Effect.mapError((cause) => errorFor("container-cleanup", cause)),
              );
            const sharedKey = `${engine}:${helperImage.image}`;
            let sharedHelper = sharedHelpers.get(sharedKey);
            if (options.reuse && sharedHelper === undefined) {
              sharedHelper = yield* Effect.acquireRelease(
                phase("helper-setup", launchHelper),
                (helper) => phase("helper-teardown", stopAndRemove(helper)).pipe(Effect.ignore),
              );
              sharedHelpers.set(sharedKey, sharedHelper);
            }
            const withHelper = <A>(
              operation: (
                helper: ContainerProcess,
              ) => Effect.Effect<A, DatabaseSnapshotError, Scope.Scope>,
            ): Effect.Effect<A, DatabaseSnapshotError, Scope.Scope> =>
              options.reuse && sharedHelper !== undefined
                ? operation(sharedHelper)
                : Effect.scoped(
                    Effect.acquireUseRelease(
                      phase("helper-setup", launchHelper),
                      operation,
                      (helper) => phase("helper-teardown", stopAndRemove(helper)),
                    ),
                  );

            const readReady = Effect.fn("DatabaseSnapshotDockerSession.readReady")(() =>
              fs.readFileString(path.join(instanceRoot, ".supabase-database-ready.json")).pipe(
                Effect.flatMap((marker) =>
                  Schema.decodeEffect(Schema.fromJsonString(ReadyMarker))(marker),
                ),
                Effect.mapError((cause) => errorFor("ready", cause)),
              ),
            );
            const exportSnapshot = ({ destination }: { readonly destination: string }) =>
              Effect.gen(function* () {
                const destinationPath = yield* contained(destination, "destination");
                const ready = yield* readReady();
                if (
                  ready.version !== version ||
                  ready.runtime !== instance.runtime ||
                  ready.profile !== "supabase"
                )
                  return yield* errorFor(
                    "ready",
                    "Database readiness marker does not match the instance",
                  );
                if (yield* fs.exists(destinationPath))
                  return yield* errorFor("export", "Destination already exists");
                const dataPath = path.join(instanceRoot, "data");
                const archiveToken = yield* crypto.randomUUIDv4.pipe(
                  Effect.mapError((cause) => errorFor("export", cause)),
                );
                const archivePath = path.join(
                  path.dirname(destinationPath),
                  `.supabase-snapshot-${archiveToken}.tar`,
                );
                const stage = yield* fs.makeTempDirectory({
                  directory: path.dirname(destinationPath),
                  prefix: ".supabase-docker-session-",
                });
                const metadata = path.join(instanceRoot, "metadata");
                if (yield* fs.exists(metadata)) {
                  yield* fs.remove(stage, { recursive: true, force: true });
                  return yield* errorFor("export", "Instance metadata directory already exists");
                }
                try {
                  yield* fs.writeFileString(archivePath, "", { mode: 0o600 });
                  yield* fs.makeDirectory(metadata, { recursive: true });
                  const encoded = yield* Schema.encodeEffect(
                    Schema.fromJsonString(SnapshotDescriptor),
                  )(descriptor);
                  yield* fs.writeFileString(path.join(metadata, "descriptor.json"), encoded, {
                    mode: 0o600,
                  });
                  yield* withHelper((helper) =>
                    phase(
                      "export",
                      exec(
                        helper,
                        engine,
                        `/usr/bin/busybox test -d ${workspacePath(dataPath)} && /usr/bin/busybox test -f ${workspacePath(path.join(dataPath, "PG_VERSION"))} && /usr/bin/busybox test ! -e ${workspacePath(path.join(dataPath, "postmaster.pid"))} && /usr/bin/busybox tar -cf ${workspacePath(archivePath)} -C ${workspacePath(instanceRoot)} data metadata`,
                        "export",
                      ),
                    ),
                  );
                  yield* phase("publish", fs.link(archivePath, destinationPath));
                  yield* fs.remove(archivePath);
                  return { descriptor, destination: destinationPath };
                } finally {
                  yield* fs.remove(archivePath, { force: true });
                  yield* fs.remove(path.join(instanceRoot, "metadata"), {
                    recursive: true,
                    force: true,
                  });
                  yield* fs.remove(stage, { recursive: true, force: true });
                }
              }).pipe(Effect.mapError((cause) => errorFor("export", cause)));

            const restoreSnapshot = ({ source }: { readonly source: string }) =>
              Effect.gen(function* () {
                const sourcePath = yield* contained(source, "source");
                const stage = yield* fs.makeTempDirectory({
                  directory: instanceRoot,
                  prefix: ".supabase-docker-restore-",
                });
                try {
                  const archivePath = path.join(stage, "source.tar");
                  yield* phase("stage", fs.copyFile(sourcePath, archivePath));
                  const descriptorPath = path.join(stage, "descriptor.json");
                  const namesPath = path.join(stage, "names");
                  const typesPath = path.join(stage, "types");
                  yield* Effect.all(
                    [descriptorPath, namesPath, typesPath].map((file) =>
                      fs
                        .writeFileString(file, "", { mode: 0o600 })
                        .pipe(Effect.mapError((cause) => errorFor("stage", cause))),
                    ),
                  );
                  const incoming = yield* withHelper<SnapshotDescriptor>((helper) =>
                    Effect.gen(function* () {
                      yield* phase(
                        "validate-container",
                        exec(
                          helper,
                          engine,
                          `set -eo pipefail; if test -e ${workspacePath(path.join(instanceRoot, "data"))} && test -n "$(/usr/bin/busybox ls -A ${workspacePath(path.join(instanceRoot, "data"))})"; then echo target data directory is not empty >&2; exit 42; fi; { /usr/bin/busybox tar -xOf ${workspacePath(archivePath)} metadata/descriptor.json 2>/dev/null || /usr/bin/busybox tar -xOf ${workspacePath(archivePath)} ./metadata/descriptor.json; } | /usr/bin/busybox head -c 65537 > ${workspacePath(descriptorPath)}; if test "$(/usr/bin/busybox wc -c < ${workspacePath(descriptorPath)})" -ge 65537; then echo snapshot descriptor exceeds 64 KiB >&2; exit 44; fi; /usr/bin/busybox tar -tf ${workspacePath(archivePath)} > ${workspacePath(namesPath)}; /usr/bin/busybox tar -tvf ${workspacePath(archivePath)} > ${workspacePath(typesPath)}`,
                          "validate",
                        ),
                      );
                      const descriptorSize = yield* fs
                        .stat(descriptorPath)
                        .pipe(Effect.mapError((cause) => errorFor("descriptor", cause)));
                      if (descriptorSize.size > 65536n)
                        return yield* errorFor("descriptor", "Snapshot descriptor exceeds 64 KiB");
                      const descriptorText = yield* fs
                        .stream(descriptorPath, { bytesToRead: 65536, chunkSize: 65536 })
                        .pipe(
                          Stream.decodeText,
                          Stream.runFold(
                            () => "",
                            (all, chunk) => `${all}${chunk}`,
                          ),
                          Effect.mapError((cause) => errorFor("descriptor", cause)),
                        );
                      const incoming = yield* Schema.decodeEffect(
                        Schema.fromJsonString(SnapshotDescriptor),
                      )(descriptorText).pipe(
                        Effect.mapError((cause) => errorFor("descriptor", cause)),
                      );
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
                        const name = line.replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
                        return name.length === 0 ||
                          ((["data", "metadata", "metadata/descriptor.json"].includes(name) ||
                            name.startsWith("data/")) &&
                            safeRelative(name))
                          ? Effect.void
                          : Effect.fail(errorFor("validate", `Unsafe snapshot member: ${name}`));
                      };
                      const validateListing = (
                        file: string,
                        validator: (line: string) => Effect.Effect<void, DatabaseSnapshotError>,
                      ) =>
                        fs.stream(file).pipe(
                          Stream.decodeText,
                          Stream.splitLines,
                          Stream.runForEach(validator),
                          Effect.mapError((cause) =>
                            cause instanceof DatabaseSnapshotError
                              ? cause
                              : errorFor("validate", cause),
                          ),
                        );
                      yield* phase(
                        "validate-host",
                        Effect.all([
                          validateListing(namesPath, validateName),
                          validateListing(typesPath, (line) =>
                            line.length === 0 || line[0] === "-" || line[0] === "d"
                              ? Effect.void
                              : Effect.fail(
                                  errorFor("validate", "Snapshot contains a non-regular member"),
                                ),
                          ),
                        ]).pipe(Effect.asVoid),
                      );
                      const extracted = path.join(stage, "extracted");
                      yield* fs
                        .makeDirectory(extracted, { recursive: true })
                        .pipe(Effect.mapError((cause) => errorFor("extract", cause)));
                      yield* phase(
                        "restore",
                        exec(
                          helper,
                          engine,
                          `set -e; trap '/usr/bin/busybox rm -rf ${workspacePath(extracted)}' EXIT; /usr/bin/busybox tar -xf ${workspacePath(archivePath)} -C ${workspacePath(extracted)}; if test ! -f ${workspacePath(path.join(extracted, "data", "PG_VERSION"))}; then echo Snapshot data is not initialized >&2; exit 43; fi; if test "$(/usr/bin/busybox cat ${workspacePath(path.join(extracted, "data", "PG_VERSION"))})" != "${version.split(".")[0]}"; then echo Snapshot data has an incompatible PostgreSQL major version >&2; exit 43; fi; /usr/bin/busybox chown -R 100:101 ${workspacePath(path.join(extracted, "data"))}; /usr/bin/busybox chmod 700 ${workspacePath(path.join(extracted, "data"))}; if test -e ${workspacePath(path.join(instanceRoot, "data"))}; then /usr/bin/busybox rmdir ${workspacePath(path.join(instanceRoot, "data"))}; fi; /usr/bin/busybox mv ${workspacePath(path.join(extracted, "data"))} ${workspacePath(path.join(instanceRoot, "data"))}`,
                          "restore",
                        ),
                      );
                      return incoming;
                    }),
                  );
                  const marker = yield* Schema.encodeEffect(Schema.fromJsonString(ReadyMarker))({
                    version,
                    runtime: instance.runtime,
                    profile: "supabase",
                  });
                  yield* fs.writeFileString(
                    path.join(instanceRoot, ".supabase-database-ready.json"),
                    marker,
                    {
                      mode: 0o600,
                    },
                  );
                  return { descriptor: incoming, destination: sourcePath };
                } finally {
                  yield* fs.remove(stage, { recursive: true, force: true });
                }
              }).pipe(Effect.mapError((cause) => errorFor("restore", cause)));

            return { exportSnapshot, restoreSnapshot };
          }),
      );

      return { forInstance } satisfies DockerSnapshotSession;
    }),
);

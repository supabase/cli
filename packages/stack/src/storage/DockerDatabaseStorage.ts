import {
  Cause,
  Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import type {
  ChildProcessHandle,
  ChildProcessSpawner as ChildProcessSpawnerService,
} from "effect/unstable/process/ChildProcessSpawner";
import { postgresVersion, resolveArtifact } from "../Artifacts.ts";
import { failureMessage } from "../internal/failure-message.ts";
import { testRunLabelArgs as readTestRunLabelArgs } from "../internal/test-run-label.ts";
import * as Publication from "../namespace/Publication.ts";
import type { ContainerRuntime, EngineTarget } from "../runtime/Container.ts";
import { composeProjectFor } from "../runtime/ContainerName.ts";
import type { DatabaseRuntime } from "../services/Database.ts";
import {
  DatabaseSnapshotError,
  instanceSnapshotsDirectory,
  makeSnapshotStore,
  type SnapshotScope,
} from "../services/DatabaseSnapshot.ts";
import type { DockerHelperRegistry } from "./DockerHelperRegistry.ts";
import { makeDockerSnapshotBackend, shellQuote } from "./DockerSnapshotBackend.ts";

const Marker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  volume: Schema.optionalKey(Schema.String),
  namespace: Schema.String,
  cacheNamespace: Schema.String,
  daemonId: Schema.optionalKey(Schema.String),
  initialized: Schema.Boolean,
});
type Marker = Schema.Schema.Type<typeof Marker>;
const DaemonIdentity = Schema.Struct({
  daemonId: Schema.String,
  clientMajor: Schema.Finite,
  serverMajor: Schema.Finite,
});
type DaemonIdentity = Schema.Schema.Type<typeof DaemonIdentity>;
interface ResolvedDaemon extends DaemonIdentity {
  readonly stateDigest: string;
  readonly volume: string;
  readonly cacheDigest: string;
  /** True when this process queried the daemon, rather than reading the cache file. */
  readonly observed: boolean;
  /** True when the shared volume was already present on this daemon. */
  readonly volumeConfirmed: boolean;
}

export class DockerDatabaseStorageError extends Schema.TaggedError<DockerDatabaseStorageError>()(
  "DockerDatabaseStorageError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface DatabaseStorageMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly type?: "bind" | "volume";
  readonly volumeSubpath?: string;
}

export interface DockerDatabaseStorage {
  readonly prepare: (version: string) => Effect.Effect<void, DockerDatabaseStorageError>;
  readonly needsDataChown: Effect.Effect<boolean, DockerDatabaseStorageError>;
  readonly mount: (
    version: string,
  ) => Effect.Effect<DatabaseStorageMount, DockerDatabaseStorageError>;
  readonly markInitialized: (version: string) => Effect.Effect<void, DockerDatabaseStorageError>;
  readonly removeData: (version: string) => Effect.Effect<void, DockerDatabaseStorageError>;
  readonly destroyData: (version: string) => Effect.Effect<void, DockerDatabaseStorageError>;
  readonly saveSnapshot: (
    version: string,
    key: string,
    scope?: SnapshotScope,
  ) => Effect.Effect<void, DockerDatabaseStorageError>;
  readonly restoreSnapshot: (
    version: string,
    key: string,
    scope?: SnapshotScope,
  ) => Effect.Effect<boolean, DockerDatabaseStorageError>;
}

// Snapshot failures keep the protocol's operation so both engines report the same step.
const errorFor = (operation: string, cause: unknown) =>
  Schema.is(DockerDatabaseStorageError)(cause)
    ? cause
    : Schema.is(DatabaseSnapshotError)(cause)
      ? new DockerDatabaseStorageError({
          operation: cause.operation,
          message: cause.message,
          cause,
        })
      : new DockerDatabaseStorageError({ operation, message: failureMessage(cause), cause });

const parseMajor = (version: string): number | undefined => {
  const major = Number(version.trim().split(".")[0]);
  return Number.isInteger(major) ? major : undefined;
};

/** Derives the shared Docker volume name from a state-root/daemon identity digest. */
const volumeNameFor = (stateDigest: string): string => `supabase-db-${stateDigest.slice(0, 32)}`;

/** Labels volumes and containers this run creates, when `SUPABASE_STACK_TEST_RUN` is set. */
const testRunLabelArgs = Effect.fn("DockerDatabaseStorage.testRunLabelArgs")(function* () {
  return yield* readTestRunLabelArgs.pipe(Effect.mapError((cause) => errorFor("config", cause)));
});

/** Owns the placement and lifecycle of one database's Docker data and snapshot namespaces. */
export const makeDockerDatabaseStorage = Effect.fn("DockerDatabaseStorage.make")(
  (options: {
    readonly runtime: DatabaseRuntime;
    /** The engine endpoint and identity the owner resolved once at startup. */
    readonly target: EngineTarget;
    readonly stackId: string;
    readonly instanceId: string;
    readonly project?: string;
    readonly instanceRoot: string;
    readonly root: string;
    readonly cacheRoot: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly crypto: Crypto.Crypto;
    readonly container: ContainerRuntime | undefined;
    readonly spawner: ChildProcessSpawnerService["Service"];
    readonly helpers?: DockerHelperRegistry;
  }): Effect.Effect<DockerDatabaseStorage, DockerDatabaseStorageError, Scope.Scope> =>
    Effect.gen(function* () {
      const markerPath = options.path.join(options.instanceRoot, ".supabase-database-storage.json");
      // Atomic (stage, fsync, rename, fsync the directory), so a kill mid-write leaves the prior
      // marker fully decodable rather than a partially written one.
      const publishMarker = (content: string) =>
        Publication.publish(options.fs, options.path, {
          target: markerPath,
          content,
        }).pipe(Effect.mapError((cause) => errorFor("marker", cause)));
      const composeHelperLabels = [
        "--label",
        `com.docker.compose.project=${composeProjectFor(options.stackId, options.project)}`,
        "--label",
        "com.docker.compose.service=database-helper",
      ];
      const stateRoot = options.path.dirname(options.path.dirname(options.root));
      const dataNamespace = `instance-${options.stackId}-${options.instanceId}`;
      const hash = (value: string) =>
        options.crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
          Effect.map((bytes) =>
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
          Effect.mapError((cause) => errorFor("identity", cause)),
        );
      const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(Marker));
      const validateMarker = (marker: Marker) =>
        Effect.gen(function* () {
          if (
            marker.namespace !== dataNamespace ||
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(marker.namespace) ||
            !/^cache-[a-f0-9]{32}$/u.test(marker.cacheNamespace) ||
            (marker.volume !== undefined &&
              !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(marker.volume))
          )
            return yield* errorFor("data", "Recorded database storage identity is invalid");
          return marker;
        });
      // engineCommand is created just below; callers run only after this assignment.
      let resolveDaemon: (
        forceLive: boolean,
      ) => Effect.Effect<ResolvedDaemon, DockerDatabaseStorageError> = () =>
        Effect.die("Docker daemon identity was resolved before the engine command existed");
      const hostData = options.path.join(options.instanceRoot, "data");
      const hasUnmarkedData = Effect.gen(function* () {
        if (
          !(yield* options.fs
            .exists(hostData)
            .pipe(Effect.mapError((cause) => errorFor("data", cause))))
        )
          return false;
        return yield* options.fs.readDirectory(hostData).pipe(
          Effect.map((entries) => entries.length > 0),
          // An inaccessible directory cannot be proven empty; treat it as non-empty.
          Effect.orElseSucceed(() => true),
        );
      });
      // This package always writes the storage marker before populating data, so non-empty
      // unmarked data indicates a corrupted state rather than legacy data.
      const rejectUnmarkedData = Effect.gen(function* () {
        if (yield* hasUnmarkedData)
          return yield* errorFor("data", "Database data exists without a storage marker");
      });
      const selectedCache = yield* Ref.make<Marker | undefined>(undefined);
      const selectionLock = yield* Semaphore.make(1);
      const selected = selectionLock.withPermit(
        Effect.gen(function* () {
          const cached = yield* Ref.get(selectedCache);
          if (cached !== undefined) return cached;
          const value = yield* Effect.gen(function* () {
            if (options.runtime === "native" || options.container === undefined)
              return {
                backend: "host" as const,
                namespace: dataNamespace,
                cacheNamespace: "native",
                initialized: false,
              };
            // Podman has no volume-subpath backend; its data always lives in host directories.
            if (options.target.engine === "podman") {
              const present = yield* options.fs
                .exists(markerPath)
                .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
              yield* options.fs
                .makeDirectory(options.cacheRoot, { recursive: true })
                .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
              const cacheRoot = yield* options.fs
                .realPath(options.cacheRoot)
                .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
              const cacheNamespace = `cache-${(yield* hash(cacheRoot)).slice(0, 32)}`;
              if (present) {
                const marker = yield* options.fs.readFileString(markerPath).pipe(
                  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Marker))),
                  Effect.mapError((cause) => errorFor("marker", cause)),
                  Effect.flatMap(validateMarker),
                );
                if (marker.cacheNamespace === cacheNamespace) return marker;
                const updated = { ...marker, cacheNamespace };
                yield* publishMarker(yield* encodeMarker(updated));
                return updated;
              }
              yield* rejectUnmarkedData;
              const value: Marker = {
                backend: "host",
                namespace: dataNamespace,
                cacheNamespace,
                initialized: false,
              };
              yield* publishMarker(yield* encodeMarker(value));
              return value;
            }
            let resolved = yield* resolveDaemon(false);
            const markerPresent = yield* options.fs
              .exists(markerPath)
              .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
            const marker = markerPresent
              ? Option.some(
                  yield* options.fs.readFileString(markerPath).pipe(
                    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Marker))),
                    Effect.mapError((cause) => errorFor("marker", cause)),
                  ),
                )
              : Option.none<Marker>();
            if (Option.isSome(marker)) {
              const validMarker = yield* validateMarker(marker.value);
              if (marker.value.backend === "docker") {
                if (
                  !resolved.observed &&
                  (validMarker.daemonId !== resolved.daemonId ||
                    validMarker.volume !== resolved.volume)
                )
                  resolved = yield* resolveDaemon(true);
                if (validMarker.daemonId !== resolved.daemonId)
                  return yield* errorFor(
                    "data",
                    "Recorded Docker database storage does not match this daemon",
                  );
                if (validMarker.volume === undefined)
                  return yield* errorFor("data", "Recorded Docker storage volume is missing");
                if (validMarker.volume !== resolved.volume)
                  return yield* errorFor(
                    "data",
                    "Recorded Docker database storage belongs to another state directory",
                  );
                if (!resolved.volumeConfirmed)
                  yield* engineCommand(["volume", "inspect", resolved.volume]).pipe(
                    Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                      !validMarker.initialized &&
                      /(?:no such volume|not found)/iu.test(cause.message)
                        ? testRunLabelArgs().pipe(
                            Effect.flatMap((testRunLabel) =>
                              engineCommand([
                                "volume",
                                "create",
                                "--label",
                                "com.supabase.stack-managed=true",
                                "--label",
                                `com.supabase.stack-state-root=${resolved.stateDigest}`,
                                ...testRunLabel,
                                resolved.volume,
                              ]),
                            ),
                            Effect.asVoid,
                          )
                        : Effect.fail(cause),
                    ),
                  );
              }
              const updated =
                validMarker.cacheNamespace === `cache-${resolved.cacheDigest.slice(0, 32)}`
                  ? validMarker
                  : {
                      ...validMarker,
                      cacheNamespace: `cache-${resolved.cacheDigest.slice(0, 32)}`,
                    };
              if (updated !== validMarker) yield* publishMarker(yield* encodeMarker(updated));
              return updated;
            }
            yield* rejectUnmarkedData;
            // Docker 26 introduced volume-subpath. Older engines retain the host-backed path.
            const backend =
              resolved.clientMajor >= 26 && resolved.serverMajor >= 26 ? "docker" : "host";
            const value: Marker = {
              backend,
              ...(backend === "docker"
                ? {
                    volume: resolved.volume,
                    daemonId: resolved.daemonId,
                  }
                : {}),
              namespace: dataNamespace,
              cacheNamespace: `cache-${resolved.cacheDigest.slice(0, 32)}`,
              initialized: false,
            };
            if (backend === "docker" && !resolved.volumeConfirmed) {
              yield* engineCommand(["volume", "inspect", resolved.volume]).pipe(
                Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                  /no such volume|not found/iu.test(cause.message)
                    ? testRunLabelArgs().pipe(
                        Effect.flatMap((testRunLabel) =>
                          engineCommand([
                            "volume",
                            "create",
                            "--label",
                            "com.supabase.stack-managed=true",
                            "--label",
                            `com.supabase.stack-state-root=${resolved.stateDigest}`,
                            ...testRunLabel,
                            resolved.volume,
                          ]),
                        ),
                        Effect.asVoid,
                      )
                    : Effect.fail(cause),
                ),
                Effect.asVoid,
              );
            }
            yield* publishMarker(yield* encodeMarker(value));
            return value;
          });
          yield* Ref.set(selectedCache, value);
          return value;
        }),
      );

      const engineCommand = Effect.fn("DockerDatabaseStorage.engineCommand")(
        (args: ReadonlyArray<string>): Effect.Effect<string, DockerDatabaseStorageError> =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "process.executable.name": options.target.engine,
                "process.arg_count": args.length,
              });
              const child = yield* options.spawner
                .spawn(
                  ChildProcess.make(options.target.engine, [...options.target.argv, ...args], {
                    stdin: "ignore",
                  }),
                )
                .pipe(Effect.mapError((cause) => errorFor("engine", cause)));
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  child.stdout.pipe(
                    Stream.decodeText,
                    Stream.runFold(
                      () => "",
                      (all: string, chunk: string) => all + chunk,
                    ),
                  ),
                  child.stderr.pipe(
                    Stream.decodeText,
                    Stream.runFold(
                      () => "",
                      (all: string, chunk: string) => all + chunk,
                    ),
                  ),
                  child.exitCode.pipe(Effect.mapError((cause) => errorFor("engine", cause))),
                ],
                { concurrency: "unbounded" },
              );
              yield* Effect.annotateCurrentSpan("process.exit_code", Number(code));
              if (Number(code) !== 0)
                return yield* errorFor(
                  "engine",
                  stderr.trim() || `Container engine exited with ${code}`,
                );
              return stdout.trim();
            }),
          ).pipe(Effect.mapError((cause) => errorFor("engine", cause))),
      );
      const daemonIdentityRef = yield* Ref.make<ResolvedDaemon | undefined>(undefined);
      const encodeDaemonIdentity = Schema.encodeEffect(Schema.fromJsonString(DaemonIdentity));
      const identityPath = options.path.join(options.cacheRoot, "docker-daemon-identity.json");
      const volumePresent = (name: string) =>
        engineCommand(["volume", "inspect", name]).pipe(
          Effect.as(true),
          Effect.catchTag("DockerDatabaseStorageError", (cause) =>
            /no such volume|not found/iu.test(cause.message)
              ? Effect.succeed(false)
              : Effect.fail(cause),
          ),
        );
      // The daemon id is the owner's own pinned target, resolved once at startup; only the
      // version, which that target's identity says nothing about, still needs the daemon itself.
      const probeDaemonVersion: Effect.Effect<DaemonIdentity, DockerDatabaseStorageError> =
        Effect.gen(function* () {
          const daemonId = options.target.daemonId;
          const version = yield* engineCommand([
            "version",
            "--format",
            "{{.Client.Version}}|{{.Server.Version}}",
          ]);
          const [clientVersion, serverVersion] = version.split("|");
          const clientMajor = parseMajor(clientVersion ?? "");
          const serverMajor = parseMajor(serverVersion ?? "");
          if (clientMajor === undefined || serverMajor === undefined)
            return yield* errorFor("engine", "Docker returned an invalid version");
          const identity = { daemonId, clientMajor, serverMajor };
          // The next process, including a shadow diff, reuses this instead of asking the daemon.
          yield* encodeDaemonIdentity(identity).pipe(
            Effect.flatMap((encoded) =>
              options.fs.writeFileString(identityPath, encoded, { mode: 0o600 }),
            ),
            Effect.ignore,
          );
          return identity;
        });
      const readDaemonIdentity = options.fs.readFileString(identityPath).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DaemonIdentity))),
        Effect.orElseSucceed(() => undefined),
      );
      resolveDaemon = (forceLive) =>
        Effect.gen(function* () {
          if (!forceLive) {
            const remembered = yield* Ref.get(daemonIdentityRef);
            if (remembered !== undefined) return remembered;
          }
          const canonicalStateRoot = yield* options.fs
            .realPath(stateRoot)
            .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
          yield* options.fs
            .makeDirectory(options.cacheRoot, { recursive: true })
            .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
          const canonicalCacheRoot = yield* options.fs
            .realPath(options.cacheRoot)
            .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
          const cacheDigest = yield* hash(canonicalCacheRoot);
          const describe = (
            identity: DaemonIdentity,
            observed: boolean,
            volumeConfirmed: boolean,
          ) =>
            Effect.map(hash(`${canonicalStateRoot}\0${identity.daemonId}`), (stateDigest) => ({
              ...identity,
              stateDigest,
              volume: volumeNameFor(stateDigest),
              cacheDigest,
              observed,
              volumeConfirmed,
            }));
          if (!forceLive) {
            const cached = yield* readDaemonIdentity;
            if (
              cached !== undefined &&
              cached.daemonId.length > 0 &&
              Number.isInteger(cached.clientMajor) &&
              Number.isInteger(cached.serverMajor)
            ) {
              const candidate = yield* describe(cached, false, false);
              if (yield* volumePresent(candidate.volume)) {
                const accepted = { ...candidate, volumeConfirmed: true };
                yield* Ref.set(daemonIdentityRef, accepted);
                return accepted;
              }
            }
          }
          const resolved = yield* describe(yield* probeDaemonVersion, true, false);
          yield* Ref.set(daemonIdentityRef, resolved);
          return resolved;
        });
      const validateDockerMarkerIdentity = (marker: Marker) =>
        Effect.gen(function* () {
          let resolved = yield* resolveDaemon(false);
          const matches = (candidate: ResolvedDaemon) =>
            marker.daemonId === candidate.daemonId && marker.volume === candidate.volume;
          if (!matches(resolved) && !resolved.observed) resolved = yield* resolveDaemon(true);
          if (marker.daemonId !== resolved.daemonId)
            return yield* errorFor(
              "destroy",
              "Recorded Docker database storage belongs to another daemon; switch back to the original Docker context before destroying it",
            );
          const canonicalStateRoot = yield* options.fs
            .realPath(stateRoot)
            .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
          const stateDigest = yield* hash(`${canonicalStateRoot}\0${resolved.daemonId}`);
          const expectedVolume = volumeNameFor(stateDigest);
          if (marker.volume !== expectedVolume)
            return yield* errorFor(
              "destroy",
              "Recorded Docker database storage belongs to another state directory",
            );
        });

      const helperId = yield* Ref.make<string | undefined>(undefined);
      const helperImage = yield* Ref.make<string | undefined>(undefined);
      const helperScopeRef = yield* Ref.make<Scope.Scope | undefined>(undefined);
      const helperCleanupPending = yield* Ref.make(false);
      const operationLock = yield* Semaphore.make(1);
      const ownerScope = yield* Scope.Scope;
      const mountField = (key: string, value: string) => {
        const field = `${key}=${value}`;
        return /[",\n\r]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
      };
      const mountArgs = (mounts: ReadonlyArray<DatabaseStorageMount>) =>
        mounts.flatMap((mount) => [
          "--mount",
          [
            `type=${mount.type ?? "bind"}`,
            mountField("src", mount.source),
            mountField("dst", mount.target),
            ...(mount.volumeSubpath === undefined
              ? []
              : [mountField("volume-subpath", mount.volumeSubpath)]),
            ...(mount.readOnly ? ["ro"] : []),
          ].join(","),
        ]);
      const startAttachedHelper = Effect.fn("DockerDatabaseStorage.startAttachedHelper")(function* (
        name: string,
        mounts: ReadonlyArray<DatabaseStorageMount>,
        image: string,
        labels: ReadonlyArray<string>,
      ) {
        const testRunLabel = yield* testRunLabelArgs();
        const stderrTail = (process: ChildProcessHandle) =>
          process.stderr.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (tail, chunk) => (tail + chunk).slice(-4096),
            ),
            Effect.forkScoped,
          );
        // Create the container before attaching so its name exists on the daemon before any
        // readiness timeout can fire. A `run` client killed mid-create leaves the daemon to
        // finish creating a container that nothing ever starts, so `--rm` never fires and a
        // later `rm -f` by name finds nothing to remove. `--rm -i` on `create` sets the same
        // AutoRemove and StdinOnce as on `run`, so stdin EOF still ends the helper when the
        // attached client dies. The create is bounded like readiness so a stalled daemon cannot
        // hang shutdown; the owned name is already registered, so the cleanup that follows a
        // failure removes a helper the daemon finishes creating late, and the stack sweep on
        // stop and destroy removes one left behind by an owner killed before `start`.
        const creator = yield* options.spawner
          .spawn(
            ChildProcess.make(
              options.target.engine,
              [
                ...options.target.argv,
                "create",
                "--rm",
                "-i",
                "--name",
                name,
                "--label",
                "com.supabase.stack-managed=true",
                "--label",
                `com.supabase.stack=${options.stackId}`,
                ...labels.flatMap((label) => ["--label", label]),
                "--label",
                `com.supabase.stack-root=${options.path.resolve(options.root)}`,
                ...composeHelperLabels,
                ...testRunLabel,
                ...mountArgs(mounts),
                image,
                "/bin/sh",
                "-c",
                "trap 'exit 0' TERM INT; printf 'supabase-helper-ready\\n'; while IFS= read -r line; do :; done",
              ],
              { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds" },
            ),
          )
          .pipe(Effect.mapError((cause) => errorFor("helper", cause)));
        const createStderr = yield* stderrTail(creator);
        const created = yield* Effect.all(
          [creator.stdout.pipe(Stream.decodeText, Stream.runDrain), creator.exitCode],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("30 seconds"), Effect.exit);
        const createTail = (yield* Fiber.join(createStderr).pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        )).trim();
        if (Exit.isFailure(created) || Number(created.value[1]) !== 0) {
          yield* creator
            .kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
            .pipe(Effect.ignore);
          const reason = Exit.isFailure(created)
            ? Option.match(Cause.findErrorOption(created.cause), {
                onNone: () => Cause.pretty(created.cause),
                onSome: (error) =>
                  Cause.isTimeoutError(error)
                    ? "Database helper was not created within 30 seconds"
                    : failureMessage(error),
              })
            : createTail || `Container engine exited with ${created.value[1]}`;
          return yield* errorFor(
            "helper",
            Exit.isFailure(created) && createTail !== "" ? `${reason}: ${createTail}` : reason,
          );
        }
        const child = yield* options.spawner
          .spawn(
            ChildProcess.make(
              options.target.engine,
              [...options.target.argv, "start", "--attach", "--interactive", name],
              { stdin: "pipe", stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds" },
            ),
          )
          .pipe(Effect.mapError((cause) => errorFor("helper", cause)));
        const stderr = yield* stderrTail(child);
        return yield* child.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
          Effect.timeout("30 seconds"),
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) &&
            Option.isSome(exit.value) &&
            exit.value.value === "supabase-helper-ready"
              ? Effect.succeed(name)
              : Effect.gen(function* () {
                  yield* child
                    .kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
                    .pipe(Effect.ignore);
                  const diagnostic = yield* Fiber.join(stderr).pipe(
                    Effect.timeout("1 second"),
                    Effect.orElseSucceed(() => ""),
                  );
                  // Docker prints warnings such as a platform mismatch on `create`, so keep that
                  // output alongside what `start` wrote.
                  const tail = [createTail, diagnostic.trim()]
                    .filter((part) => part !== "")
                    .join("\n");
                  const reason = Exit.isFailure(exit)
                    ? Option.match(Cause.findErrorOption(exit.cause), {
                        onNone: () => Cause.pretty(exit.cause),
                        onSome: (error) =>
                          Cause.isTimeoutError(error)
                            ? "Database helper did not become ready within 30 seconds"
                            : failureMessage(error),
                      })
                    : "Database helper exited before becoming ready";
                  // Stderr can hold only warnings unless the helper exited on its own.
                  return yield* errorFor(
                    "helper",
                    Exit.isFailure(exit) && tail !== "" ? `${reason}: ${tail}` : tail || reason,
                  );
                }),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? child
                  .kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      });
      const removeHelper = Effect.fn("DockerDatabaseStorage.removeHelper")(() =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(helperId);
            if (current !== undefined) {
              const helperScope = yield* Ref.get(helperScopeRef);
              // Keep the owned identity until the remote container is gone.
              yield* engineCommand(["rm", "-f", current]).pipe(
                Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                  /no such container/iu.test(cause.message) ? Effect.void : Effect.fail(cause),
                ),
                Effect.ensuring(
                  helperScope === undefined ? Effect.void : Scope.close(helperScope, Exit.void),
                ),
              );
              yield* Ref.set(helperId, undefined);
              yield* Ref.set(helperImage, undefined);
              yield* Ref.set(helperScopeRef, undefined);
              yield* Ref.set(helperCleanupPending, false);
            }
          }),
        ),
      );
      yield* Scope.addFinalizer(
        ownerScope,
        removeHelper().pipe(
          Effect.tapError((cause) => Effect.logError(cause)),
          Effect.ignore,
        ),
      );
      const imageForVersion = (version: string, fallback: boolean) =>
        resolveArtifact({ service: "database", version: postgresVersion(version) }).pipe(
          Effect.map(({ image }) => image),
          Effect.catchTag("ArtifactError", (cause) =>
            fallback
              ? resolveArtifact({ service: "database" }).pipe(Effect.map(({ image }) => image))
              : Effect.fail(cause),
          ),
          Effect.mapError((cause) => errorFor("helper", cause)),
        );
      const acquireHelper = Effect.fn("DockerDatabaseStorage.acquireHelper")(
        (mounts: ReadonlyArray<DatabaseStorageMount>, image: string) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(helperId);
              if (
                current !== undefined &&
                ((yield* Ref.get(helperCleanupPending)) || (yield* Ref.get(helperImage)) !== image)
              )
                yield* removeHelper();
              const active = yield* Ref.get(helperId);
              if (active !== undefined) return active;
              if (options.container === undefined)
                return yield* errorFor("helper", "Container runtime is unavailable");
              if (
                mounts.some(
                  (mount) => mount.source === options.cacheRoot && mount.target === "/cache",
                )
              )
                yield* options.fs
                  .makeDirectory(options.cacheRoot, { recursive: true })
                  .pipe(Effect.mapError((cause) => errorFor("helper", cause)));
              const preparedImage = yield* restore(
                options.container
                  .prepareImage(image)
                  .pipe(Effect.mapError((cause) => errorFor("helper", cause))),
              );
              const token = yield* options.crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) => errorFor("helper", cause)),
              );
              const name = `supabase-db-helper-${token}`;
              // Register the owned name before remote create so interrupted startup can remove it.
              yield* Ref.set(helperId, name);
              yield* Ref.set(helperImage, image);
              const helperScope = yield* Scope.make();
              yield* Ref.set(helperScopeRef, helperScope);
              return yield* startAttachedHelper(name, mounts, preparedImage, [
                `com.supabase.instance=${options.instanceId}`,
              ]).pipe(Scope.provide(helperScope));
            }),
          ),
      );

      const missingContainer = (message: string) => /no such (?:container|object)/iu.test(message);
      const volumeHelperKey = (
        mounts: ReadonlyArray<DatabaseStorageMount>,
        image: string,
      ): string | undefined => {
        if (options.helpers === undefined) return undefined;
        if (mounts.length === 0 || mounts.some((mount) => (mount.type ?? "bind") !== "volume"))
          return undefined;
        return `${image}\0${mounts
          .map(
            (mount) =>
              `${mount.source}\0${mount.target}\0${mount.volumeSubpath ?? ""}\0${mount.readOnly ? "ro" : "rw"}`,
          )
          .sort()
          .join("\n")}`;
      };
      const closeSharedHelper = (id: string) =>
        engineCommand(["rm", "-f", id]).pipe(
          Effect.catchTag("DockerDatabaseStorageError", (cause) =>
            missingContainer(cause.message) ? Effect.void : Effect.fail(cause),
          ),
          Effect.asVoid,
        );
      // Clear a helper left behind by an earlier failed close from this owner.
      const openSharedHelper = Effect.fn("DockerDatabaseStorage.openSharedHelper")(function* (
        mounts: ReadonlyArray<DatabaseStorageMount>,
        key: string,
        image: string,
        ownerId: string,
      ) {
        const name = `supabase-db-helper-${(yield* hash(`${ownerId}\0${key}`)).slice(0, 32)}`;
        yield* closeSharedHelper(name);
        if (options.container === undefined)
          return yield* errorFor("helper", "Container runtime is unavailable");
        const preparedImage = yield* options.container
          .prepareImage(image)
          .pipe(Effect.mapError((cause) => errorFor("helper", cause)));
        return yield* Effect.uninterruptible(
          startAttachedHelper(name, mounts, preparedImage, ["com.supabase.stack-helper=volume"]),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? closeSharedHelper(name).pipe(Effect.catch(Effect.logError))
              : Effect.void,
          ),
        );
      });
      const runHelper = Effect.fn("DockerDatabaseStorage.helper")((
        command: string,
        mounts: ReadonlyArray<DatabaseStorageMount>,
        version: string,
        fallback = false,
      ): Effect.Effect<string, DockerDatabaseStorageError> => {
        const cleanupAfterFailure = Effect.gen(function* () {
          if ((yield* Ref.get(helperId)) === undefined) return;
          yield* Ref.set(helperCleanupPending, true);
          yield* removeHelper();
        });
        return imageForVersion(version, fallback).pipe(
          Effect.flatMap((image) => {
            const sharedKey = volumeHelperKey(mounts, image);
            if (sharedKey !== undefined && options.helpers !== undefined) {
              const helpers = options.helpers;
              const exec = (id: string) => engineCommand(["exec", id, "/bin/sh", "-c", command]);
              const open = openSharedHelper(mounts, sharedKey, image, helpers.ownerId);
              return helpers.use(sharedKey, open, closeSharedHelper, exec).pipe(
                Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                  /no such container|is not running/iu.test(cause.message)
                    ? helpers
                        .drop(sharedKey)
                        .pipe(Effect.andThen(helpers.use(sharedKey, open, closeSharedHelper, exec)))
                    : Effect.fail(cause),
                ),
                Effect.mapError((cause) => errorFor("helper", cause)),
              );
            }
            const operation = Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const id = yield* restore(acquireHelper(mounts, image));
                return yield* restore(engineCommand(["exec", id, "/bin/sh", "-c", command]));
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) ? Effect.uninterruptible(cleanupAfterFailure) : Effect.void,
                ),
                Effect.mapError((cause) => errorFor("mount", cause)),
              ),
            );
            return operationLock
              .withPermit(operation)
              .pipe(Effect.mapError((cause) => errorFor("helper", cause)));
          }),
        );
      });

      const getMarker = Effect.gen(function* () {
        const marker = yield* options.fs
          .readFileString(markerPath)
          .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Marker))));
        return yield* validateMarker(marker);
      });
      const getMarkerIfPresent = Effect.gen(function* () {
        const present = yield* options.fs
          .exists(markerPath)
          .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
        return present ? Option.some(yield* getMarker) : Option.none<Marker>();
      });
      // The in-memory resolution from `selected`, kept for the instance's lifetime across sleeps and
      // generations once resolved, independent of the on-disk marker: a marker deleted after
      // resolution must not hide a namespace this process still knows it owns.
      const resolvedFromMemory = Ref.get(selectedCache);
      const getMarkerForRemoval = Effect.gen(function* () {
        const cached = yield* resolvedFromMemory;
        if (cached !== undefined) return Option.some(cached);
        const existing = yield* getMarkerIfPresent;
        if (Option.isSome(existing) && options.runtime !== "native") {
          yield* selected;
          return Option.some(yield* getMarker);
        }
        return existing;
      });
      /**
       * Destroy tolerates a missing volume by design (`validateDockerMarkerIdentity` plus its own
       * volume-existence check below), so this skips `selected`'s stricter resolution and only adds
       * the in-memory shortcut on top of the existing on-disk read. `validated` tells the caller
       * whether `selected` already confirmed this identity in memory: a live owner's cleanup must
       * not then re-derive it from the filesystem (`realPath(stateRoot)` in
       * `validateDockerMarkerIdentity`), only a new owner discovering from disk needs that check.
       */
      const getMarkerForDestroy = Effect.gen(function* () {
        const cached = yield* resolvedFromMemory;
        if (cached !== undefined) return { marker: Option.some(cached), validated: true as const };
        return { marker: yield* getMarkerIfPresent, validated: false as const };
      });
      const readyMarkerPath = options.path.join(
        options.instanceRoot,
        ".supabase-database-ready.json",
      );
      // The host owns this file; a helper's bind-mount view can still list it after the host
      // removes it, which makes the helper's unlink fail.
      const removeReadyMarker = options.fs
        .remove(readyMarkerPath, { force: true })
        .pipe(Effect.mapError((cause) => errorFor("reset", cause)));
      /** Unmarked data cannot start, so removal is its only in-product recovery. */
      const removeUnmarkedData = (
        version: string,
        { checkpoints }: { readonly checkpoints: boolean },
      ) =>
        Effect.gen(function* () {
          const removeCheckpoints =
            checkpoints &&
            (yield* options.fs
              .exists(options.path.join(options.instanceRoot, instanceSnapshotsDirectory))
              .pipe(Effect.mapError((cause) => errorFor("data", cause))));
          if (!removeCheckpoints && !(yield* hasUnmarkedData)) return;
          yield* runHelper(
            `set -eu; rm -rf /instance/data /instance/.supabase-restore${removeCheckpoints ? ` ${shellQuote(`/instance/${instanceSnapshotsDirectory}`)}` : ""}`,
            [{ source: options.instanceRoot, target: "/instance", readOnly: false }],
            version,
            true,
          );
          yield* removeReadyMarker;
        });
      const writeMarker = (marker: Marker) =>
        encodeMarker(marker).pipe(Effect.flatMap((encoded) => publishMarker(encoded)));
      const setup = Effect.fn("DockerDatabaseStorage.prepare")((version: string) =>
        Effect.gen(function* () {
          yield* selected;
          const marker = yield* getMarker;
          if (marker.backend === "host") {
            const data = options.path.join(options.instanceRoot, "data");
            if (marker.initialized) {
              if (!(yield* options.fs.exists(data)))
                return yield* errorFor("prepare", "Initialized database data is missing");
              const major = yield* runHelper(
                "set -eu; if [ ! -f /instance/data/PG_VERSION ]; then echo 'Initialized PostgreSQL data is missing PG_VERSION' >&2; exit 1; fi; cat /instance/data/PG_VERSION",
                [
                  { source: options.instanceRoot, target: "/instance", readOnly: false },
                  { source: options.cacheRoot, target: "/cache", readOnly: false },
                ],
                version,
              );
              if (major.trim() !== majorVersion(version))
                return yield* errorFor(
                  "prepare",
                  "Initialized PostgreSQL major does not match the requested configuration",
                );
            } else {
              yield* options.fs.makeDirectory(data, { recursive: true, mode: 0o700 });
            }
            return;
          }
          const store = `/store/${marker.namespace}`;
          const cache = `/store/${marker.cacheNamespace}`;
          if (marker.initialized) {
            const major = yield* runHelper(
              `set -eu; if [ ! -f ${shellQuote(`${store}/data/PG_VERSION`)} ]; then echo 'Initialized PostgreSQL data is missing PG_VERSION' >&2; exit 1; fi; cat ${shellQuote(`${store}/data/PG_VERSION`)}`,
              [{ source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" }],
              version,
            );
            if (major.trim() !== majorVersion(version))
              return yield* errorFor(
                "prepare",
                "Initialized PostgreSQL major does not match the requested configuration",
              );
          } else {
            yield* runHelper(
              `set -eu; mkdir -p ${shellQuote(`${store}/data`)} ${shellQuote(`${cache}/entries`)} ${shellQuote(`${cache}/stages`)}; chown -R 100:101 ${shellQuote(`${store}/data`)}`,
              [{ source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" }],
              version,
            );
          }
        }).pipe(Effect.mapError((cause) => errorFor("prepare", cause))),
      );
      const majorVersion = (version: string) => version.split(".")[0] ?? version;

      const mount = (_version: string) =>
        selected.pipe(
          Effect.flatMap(() => getMarker),
          Effect.map((marker) =>
            marker.backend === "docker"
              ? {
                  source: marker.volume ?? "",
                  target: "/var/lib/postgresql/data",
                  readOnly: false,
                  type: "volume" as const,
                  volumeSubpath: `${marker.namespace}/data`,
                }
              : {
                  source: options.path.join(options.instanceRoot, "data"),
                  target: "/var/lib/postgresql/data",
                  readOnly: false,
                },
          ),
          Effect.mapError((cause) => errorFor("mount", cause)),
        );
      const needsDataChown = getMarker.pipe(
        Effect.map((marker) => marker.backend === "host"),
        Effect.mapError((cause) => errorFor("marker", cause)),
      );
      const markInitialized = Effect.fn("DockerDatabaseStorage.markInitialized")(
        (version: string) =>
          Effect.gen(function* () {
            const marker = yield* getMarker;
            if (marker.backend === "docker") {
              const versionFile = `/store/${marker.namespace}/data/PG_VERSION`;
              yield* runHelper(
                `set -eu; if [ ! -f ${shellQuote(versionFile)} ]; then echo 'Database readiness requires PG_VERSION' >&2; exit 1; fi; actual=$(cat ${shellQuote(versionFile)}); if [ "$actual" != ${shellQuote(majorVersion(version))} ]; then echo 'Database PostgreSQL major does not match requested version' >&2; exit 1; fi`,
                snapshotPaths(marker).mounts,
                version,
              );
            }
            yield* writeMarker({ ...marker, initialized: true });
          }).pipe(Effect.mapError((cause) => errorFor("ready", cause))),
      );
      const removeData = Effect.fn("DockerDatabaseStorage.removeData")((version: string) =>
        Effect.gen(function* () {
          const markerOption = yield* getMarkerForRemoval;
          if (Option.isNone(markerOption))
            return yield* removeUnmarkedData(version, { checkpoints: false });
          const marker = markerOption.value;
          if (marker.backend === "host") {
            yield* runHelper(
              `set -eu; rm -rf /instance/data /instance/.supabase-restore; mkdir -p /instance/data; chown 100:101 /instance/data`,
              snapshotPaths(marker).mounts,
              version,
              true,
            );
          } else {
            yield* runHelper(
              `set -eu; rm -rf ${shellQuote(`/store/${marker.namespace}/data`)}; mkdir -p ${shellQuote(`/store/${marker.namespace}/data`)}; chown 100:101 ${shellQuote(`/store/${marker.namespace}/data`)}`,
              [{ source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" }],
              version,
              true,
            );
          }
          yield* removeReadyMarker;
          yield* writeMarker({ ...marker, initialized: false });
        }).pipe(Effect.mapError((cause) => errorFor("reset", cause))),
      );
      const destroyData = Effect.fn("DockerDatabaseStorage.destroyData")((version: string) =>
        Effect.gen(function* () {
          const { marker: markerOption, validated } = yield* getMarkerForDestroy;
          if (Option.isNone(markerOption)) {
            yield* removeUnmarkedData(version, { checkpoints: true });
            return yield* removeHelper();
          }
          const marker = markerOption.value;
          if (marker.backend === "host") {
            yield* runHelper(
              `set -eu; rm -rf /instance/data /instance/.supabase-restore ${shellQuote(`/instance/${instanceSnapshotsDirectory}`)}`,
              snapshotPaths(marker).mounts,
              version,
              true,
            );
            yield* removeReadyMarker;
            yield* removeHelper();
          } else {
            // Memory-sourced identities were already validated by `selected` when first resolved;
            // only a marker discovered fresh from disk (a new owner recovering) needs this check.
            if (!validated) yield* validateDockerMarkerIdentity(marker);
            if (marker.volume === undefined)
              return yield* errorFor("destroy", "Recorded Docker storage volume is missing");
            const volumeExists = yield* engineCommand(["volume", "inspect", marker.volume]).pipe(
              Effect.as(true),
              Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                /no such volume/iu.test(cause.message) ? Effect.succeed(false) : Effect.fail(cause),
              ),
            );
            if (volumeExists)
              yield* runHelper(
                `set -eu; rm -rf ${shellQuote(`/store/${marker.namespace}`)}`,
                [{ source: marker.volume, target: "/store", readOnly: false, type: "volume" }],
                version,
                true,
              );
            yield* removeHelper();
          }
        }).pipe(Effect.mapError((cause) => errorFor("destroy", cause))),
      );
      const snapshotPaths = (marker: Marker) =>
        marker.backend === "docker"
          ? {
              root: `/store/${marker.cacheNamespace}`,
              source: `/store/${marker.namespace}/data`,
              mounts: [
                {
                  source: marker.volume ?? "",
                  target: "/store",
                  readOnly: false,
                  type: "volume" as const,
                },
              ],
            }
          : {
              root: `/cache/stack-database-snapshots-helper/${marker.cacheNamespace}`,
              source: "/instance/data",
              mounts: [
                { source: options.instanceRoot, target: "/instance", readOnly: false as const },
                { source: options.cacheRoot, target: "/cache", readOnly: false as const },
              ],
            };
      const snapshots = (store: Marker, version: string) => {
        const paths = snapshotPaths(store);
        const host = store.backend === "host";
        const instanceSnapshotRoot = host
          ? `/instance/${instanceSnapshotsDirectory}`
          : `/store/${store.namespace}/snapshots`;
        const exec = (script: string) => runHelper(script, paths.mounts, version);
        return makeSnapshotStore({
          backends: {
            cache: makeDockerSnapshotBackend({
              lockFile: options.path.join(
                options.cacheRoot,
                "stack-database-snapshots",
                "locks",
                `${host ? "host" : (store.volume ?? "volume")}-${store.cacheNamespace}.sqlite`,
              ),
              root: paths.root,
              data: paths.source,
              restoreStages: host ? "/instance/.supabase-restore" : `${paths.root}/stages`,
              // Host-backed snapshots stay removable by the host user; restored data belongs
              // to the database user.
              ...(host
                ? {
                    adoptOwner: "100:101",
                    epilogue: `owner=$(/usr/bin/busybox stat -c "%u:%g" /cache); /usr/bin/busybox mkdir -p /cache/stack-database-snapshots-helper; /usr/bin/busybox chown "$owner" /cache/stack-database-snapshots-helper; /usr/bin/busybox chown -R "$owner" ${shellQuote(paths.root)}`,
                  }
                : {}),
              exec,
            }),
            // Instance snapshots live beside the instance data, so destroying it removes them.
            instance: makeDockerSnapshotBackend({
              lockFile: options.path.join(
                options.instanceRoot,
                instanceSnapshotsDirectory,
                "lock.sqlite",
              ),
              root: instanceSnapshotRoot,
              data: paths.source,
              restoreStages: host
                ? "/instance/.supabase-restore"
                : `${instanceSnapshotRoot}/stages`,
              ...(host ? { adoptOwner: "100:101" } : {}),
              exec,
            }),
          },
          instanceRoot: options.instanceRoot,
          runtime: options.runtime,
          version,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, options.fs),
          Effect.provideService(Path.Path, options.path),
          Effect.provideService(Crypto.Crypto, options.crypto),
        );
      };
      const saveSnapshot = Effect.fn("DockerDatabaseStorage.saveSnapshot")(
        (version: string, key: string, scope: SnapshotScope = "cache") =>
          Effect.gen(function* () {
            yield* selected;
            const store = yield* getMarker;
            if (!store.initialized)
              return yield* errorFor("snapshot", "Database is not initialized");
            yield* (yield* snapshots(store, version)).saveSnapshot(key, scope);
          }).pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
      );
      const restoreSnapshot = Effect.fn("DockerDatabaseStorage.restoreSnapshot")(
        (version: string, key: string, scope: SnapshotScope = "cache") =>
          Effect.gen(function* () {
            yield* selected;
            const store = yield* getMarker;
            if (!(yield* (yield* snapshots(store, version)).restoreSnapshot(key, scope)))
              return false;
            yield* writeMarker({ ...store, initialized: true });
            return true;
          }).pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
      );
      return {
        prepare: setup,
        needsDataChown,
        mount,
        markInitialized,
        removeData,
        destroyData,
        saveSnapshot,
        restoreSnapshot,
      };
    }),
);

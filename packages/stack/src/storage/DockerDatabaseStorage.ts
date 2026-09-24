import {
  Crypto,
  Effect,
  Exit,
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
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import type { ContainerRuntime } from "../runtime/Container.ts";
import type { DatabaseRuntime } from "../services/Database.ts";
import type { DockerHelperRegistry } from "./DockerHelperRegistry.ts";

const HELPER_IMAGE =
  "public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const Marker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  volume: Schema.optionalKey(Schema.String),
  namespace: Schema.String,
  cacheNamespace: Schema.String,
  daemonId: Schema.optionalKey(Schema.String),
  initialized: Schema.Boolean,
});
type Marker = Schema.Schema.Type<typeof Marker>;
const SnapshotIdentity = Schema.Struct({
  format: Schema.String,
  version: Schema.String,
  runtime: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  profile: Schema.String,
  key: Schema.String,
});
const SnapshotDescriptor = Schema.Struct({
  format: Schema.String,
  version: Schema.String,
  runtime: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  profile: Schema.String,
  keyDigest: Schema.String,
});
const ReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  profile: Schema.Literal("supabase"),
});
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
  { operation: Schema.String, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
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
  ) => Effect.Effect<void, DockerDatabaseStorageError>;
  readonly restoreSnapshot: (
    version: string,
    key: string,
  ) => Effect.Effect<boolean, DockerDatabaseStorageError>;
}

const errorFor = (operation: string, cause: unknown) =>
  Schema.is(DockerDatabaseStorageError)(cause)
    ? cause
    : new DockerDatabaseStorageError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const parseMajor = (version: string): number | undefined => {
  const major = Number(version.trim().split(".")[0]);
  return Number.isInteger(major) ? major : undefined;
};

/** Owns the placement and lifecycle of one database's Docker data and snapshot namespaces. */
export const makeDockerDatabaseStorage = Effect.fn("DockerDatabaseStorage.make")(
  (options: {
    readonly runtime: DatabaseRuntime;
    readonly stackId: string;
    readonly instanceId: string;
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
      const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(SnapshotIdentity));
      const encodeDescriptor = Schema.encodeEffect(Schema.fromJsonString(SnapshotDescriptor));
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
            if (options.runtime !== "docker") {
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
                  Effect.flatMap(validateMarker),
                  Effect.mapError((cause) => errorFor("marker", cause)),
                );
                if (marker.cacheNamespace !== cacheNamespace) {
                  const updated = { ...marker, cacheNamespace };
                  yield* options.fs
                    .writeFileString(markerPath, yield* encodeMarker(updated), { mode: 0o600 })
                    .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
                  return updated;
                }
                return marker;
              }
              const hostData = options.path.join(options.instanceRoot, "data");
              const initialized =
                (yield* options.fs
                  .exists(hostData)
                  .pipe(Effect.mapError((cause) => errorFor("data", cause)))) &&
                (yield* options.fs.readDirectory(hostData).pipe(
                  Effect.map((entries) => entries.length > 0),
                  Effect.orElseSucceed(() => true),
                ));
              const value: Marker = {
                backend: "host",
                namespace: dataNamespace,
                cacheNamespace,
                initialized,
              };
              const encoded = yield* encodeMarker(value);
              yield* options.fs
                .writeFileString(markerPath, encoded, { mode: 0o600 })
                .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
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
                        ? engineCommand([
                            "volume",
                            "create",
                            "--label",
                            "com.supabase.stack-managed=true",
                            "--label",
                            `com.supabase.stack-state-root=${resolved.stateDigest}`,
                            resolved.volume,
                          ]).pipe(Effect.asVoid)
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
              if (updated !== validMarker)
                yield* options.fs
                  .writeFileString(markerPath, yield* encodeMarker(updated), { mode: 0o600 })
                  .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
              return updated;
            }
            const hostData = options.path.join(options.instanceRoot, "data");
            if (
              yield* options.fs
                .exists(hostData)
                .pipe(Effect.mapError((cause) => errorFor("data", cause)))
            ) {
              const entries = yield* options.fs.readDirectory(hostData).pipe(
                // A legacy data directory may be owned by PostgreSQL's container UID.
                // Let the root helper validate and adopt it instead of treating EACCES as empty.
                Effect.orElseSucceed(() => ["inaccessible-data"]),
              );
              if (entries.length > 0) {
                const value: Marker = {
                  backend: "host",
                  namespace: dataNamespace,
                  cacheNamespace: `cache-${resolved.cacheDigest.slice(0, 32)}`,
                  initialized: true,
                };
                const encoded = yield* encodeMarker(value);
                yield* options.fs
                  .writeFileString(markerPath, encoded, { mode: 0o600 })
                  .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
                return value;
              }
            }
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
                    ? engineCommand([
                        "volume",
                        "create",
                        "--label",
                        "com.supabase.stack-managed=true",
                        "--label",
                        `com.supabase.stack-state-root=${resolved.stateDigest}`,
                        resolved.volume,
                      ]).pipe(Effect.asVoid)
                    : Effect.fail(cause),
                ),
                Effect.asVoid,
              );
            }
            yield* options.fs
              .writeFileString(markerPath, yield* encodeMarker(value), { mode: 0o600 })
              .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
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
              const child = yield* options.spawner
                .spawn(ChildProcess.make(options.runtime, args, { stdin: "ignore" }))
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
      const probeDaemonIdentity: Effect.Effect<DaemonIdentity, DockerDatabaseStorageError> =
        Effect.gen(function* () {
          const daemonId = (yield* engineCommand(["info", "--format", "{{.ID}}"])).trim();
          const version = yield* engineCommand([
            "version",
            "--format",
            "{{.Client.Version}}|{{.Server.Version}}",
          ]);
          const [clientVersion, serverVersion] = version.split("|");
          const clientMajor = parseMajor(clientVersion ?? "");
          const serverMajor = parseMajor(serverVersion ?? "");
          if (daemonId.length === 0 || clientMajor === undefined || serverMajor === undefined)
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
              volume: `supabase-db-${stateDigest.slice(0, 32)}`,
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
          const resolved = yield* describe(yield* probeDaemonIdentity, true, false);
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
          const expectedVolume = `supabase-db-${stateDigest.slice(0, 32)}`;
          if (marker.volume !== expectedVolume)
            return yield* errorFor(
              "destroy",
              "Recorded Docker database storage belongs to another state directory",
            );
        });

      const helperId = yield* Ref.make<string | undefined>(undefined);
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
      const removeHelper = Effect.fn("DockerDatabaseStorage.removeHelper")(() =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(helperId);
            if (current !== undefined) {
              // Keep the owned identity until the remote container is gone.
              yield* engineCommand(["rm", "-f", current]).pipe(
                Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                  /no such container/iu.test(cause.message) ? Effect.void : Effect.fail(cause),
                ),
              );
              yield* Ref.set(helperId, undefined);
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
      const acquireHelper = Effect.fn("DockerDatabaseStorage.acquireHelper")(
        (mounts: ReadonlyArray<DatabaseStorageMount>) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(helperId);
              if (current !== undefined && (yield* Ref.get(helperCleanupPending)))
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
              yield* restore(options.container.prepare(HELPER_IMAGE));
              const token = yield* options.crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) => errorFor("helper", cause)),
              );
              const name = `supabase-db-helper-${token}`;
              // Register the deterministic owned name before the remote create starts so an
              // interrupted docker run can still be removed by the same scope.
              yield* Ref.set(helperId, name);
              const created = yield* engineCommand([
                "run",
                "-d",
                "--name",
                name,
                "--label",
                "com.supabase.stack-managed=true",
                "--label",
                `com.supabase.stack=${options.stackId}`,
                "--label",
                `com.supabase.instance=${options.instanceId}`,
                "--label",
                `com.supabase.stack-root=${options.path.resolve(options.root)}`,
                ...mountArgs(mounts),
                HELPER_IMAGE,
                "/bin/sh",
                "-c",
                "trap : TERM INT; while :; do sleep 3600; done",
              ]);
              if (!/^[a-f0-9]{12,64}$/u.test(created))
                return yield* errorFor("helper", "Docker returned an invalid helper identity");
              return name;
            }),
          ),
      );

      const missingContainer = (message: string) => /no such (?:container|object)/iu.test(message);
      const volumeHelperKey = (mounts: ReadonlyArray<DatabaseStorageMount>): string | undefined => {
        if (options.helpers === undefined) return undefined;
        if (mounts.length === 0 || mounts.some((mount) => (mount.type ?? "bind") !== "volume"))
          return undefined;
        return mounts
          .map(
            (mount) =>
              `${mount.source}\0${mount.target}\0${mount.volumeSubpath ?? ""}\0${mount.readOnly ? "ro" : "rw"}`,
          )
          .sort()
          .join("\n");
      };
      const closeSharedHelper = (id: string) =>
        engineCommand(["rm", "-f", id]).pipe(
          Effect.catchTag("DockerDatabaseStorageError", (cause) =>
            missingContainer(cause.message) ? Effect.void : Effect.fail(cause),
          ),
          Effect.asVoid,
        );
      // A container left in `created` cannot exec; remove it and start another.
      const openSharedHelper = (
        mounts: ReadonlyArray<DatabaseStorageMount>,
        key: string,
        ownerId: string,
      ) =>
        Effect.gen(function* () {
          const name = `supabase-db-helper-${(yield* hash(`${ownerId}\0${key}`)).slice(0, 32)}`;
          const status = yield* engineCommand([
            "inspect",
            "--format",
            "{{.State.Status}}",
            name,
          ]).pipe(
            Effect.map((value) => value.trim()),
            Effect.catchTag("DockerDatabaseStorageError", (cause) =>
              missingContainer(cause.message) ? Effect.succeed("absent") : Effect.fail(cause),
            ),
          );
          if (status === "running" || status === "restarting" || status === "paused") return name;
          if (status === "created" || status === "exited" || status === "dead") {
            const removed = yield* engineCommand(["rm", name]).pipe(
              Effect.map(() => "removed"),
              Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                missingContainer(cause.message)
                  ? Effect.succeed("absent")
                  : /is running|running container/iu.test(cause.message)
                    ? Effect.succeed("running")
                    : Effect.fail(cause),
              ),
            );
            if (removed === "running") return name;
          }
          if (options.container === undefined)
            return yield* errorFor("helper", "Container runtime is unavailable");
          yield* options.container.prepare(HELPER_IMAGE);
          return yield* Effect.uninterruptible(
            engineCommand([
              "run",
              "-d",
              "--name",
              name,
              "--label",
              "com.supabase.stack-managed=true",
              "--label",
              "com.supabase.stack-helper=volume",
              "--label",
              `com.supabase.stack=${options.stackId}`,
              "--label",
              `com.supabase.stack-root=${options.path.resolve(options.root)}`,
              ...mountArgs(mounts),
              HELPER_IMAGE,
              "/bin/sh",
              "-c",
              "trap : TERM INT; while :; do sleep 3600; done",
            ]).pipe(
              Effect.as(name),
              Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                /already in use/iu.test(cause.message) ? Effect.succeed(name) : Effect.fail(cause),
              ),
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? closeSharedHelper(name).pipe(Effect.catch(Effect.logError))
                  : Effect.void,
              ),
            ),
          );
        });
      const runHelper = Effect.fn("DockerDatabaseStorage.helper")((
        command: string,
        mounts: ReadonlyArray<DatabaseStorageMount>,
      ): Effect.Effect<string, DockerDatabaseStorageError> => {
        const sharedKey = volumeHelperKey(mounts);
        if (sharedKey !== undefined && options.helpers !== undefined) {
          const helpers = options.helpers;
          const exec = (id: string) => engineCommand(["exec", id, "/bin/sh", "-c", command]);
          const open = openSharedHelper(mounts, sharedKey, helpers.ownerId);
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
        const cleanupAfterFailure = Effect.gen(function* () {
          if ((yield* Ref.get(helperId)) === undefined) return;
          yield* Ref.set(helperCleanupPending, true);
          yield* removeHelper();
        });
        const operation = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const id = yield* restore(acquireHelper(mounts));
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
      const getMarkerForRemoval = Effect.gen(function* () {
        const existing = yield* getMarkerIfPresent;
        if (Option.isSome(existing)) {
          if (options.runtime === "docker") {
            yield* selected;
            return Option.some(yield* getMarker);
          }
          return existing;
        }
        const data = options.path.join(options.instanceRoot, "data");
        if (!(yield* options.fs.exists(data))) return Option.none<Marker>();
        const nonEmpty = yield* options.fs.readDirectory(data).pipe(
          Effect.map((entries) => entries.length > 0),
          Effect.orElseSucceed(() => true),
        );
        if (!nonEmpty) return Option.none<Marker>();
        yield* selected;
        return Option.some(yield* getMarker);
      });
      const writeMarker = (marker: Marker) =>
        encodeMarker(marker).pipe(
          Effect.flatMap((encoded) =>
            options.fs.writeFileString(markerPath, encoded, { mode: 0o600 }),
          ),
        );
      const publishReadyMarker = (version: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const stage = yield* options.fs.makeTempDirectoryScoped({
              directory: options.instanceRoot,
              prefix: ".ready-",
            });
            const ready = yield* Schema.encodeEffect(Schema.fromJsonString(ReadyMarker))({
              version,
              runtime: options.runtime,
              profile: "supabase",
            });
            const staged = options.path.join(stage, "marker");
            const destination = options.path.join(
              options.instanceRoot,
              ".supabase-database-ready.json",
            );
            yield* options.fs.writeFileString(staged, ready, { mode: 0o600 });
            yield* options.fs.rename(staged, destination);
          }),
        );
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
            );
            if (major.trim() !== majorVersion(version))
              return yield* errorFor(
                "prepare",
                "Initialized PostgreSQL major does not match the requested configuration",
              );
          } else {
            yield* runHelper(
              `set -eu; mkdir -p ${shellQuote(`${store}/data`)} ${shellQuote(`${cache}/entries`)} ${shellQuote(`${cache}/stages`)}; chown -R 100:101 ${shellQuote(store)}`,
              [{ source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" }],
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
              );
            }
            yield* writeMarker({ ...marker, initialized: true });
          }).pipe(Effect.mapError((cause) => errorFor("ready", cause))),
      );
      const removeData = Effect.fn("DockerDatabaseStorage.removeData")((_version: string) =>
        Effect.gen(function* () {
          const markerOption = yield* getMarkerForRemoval;
          if (Option.isNone(markerOption)) return;
          const marker = markerOption.value;
          if (marker.backend === "host") {
            yield* runHelper(
              `set -eu; rm -rf /instance/data /instance/.supabase-restore-*; mkdir -p /instance/data; chown 100:101 /instance/data`,
              snapshotPaths(marker).mounts,
            );
          } else {
            yield* runHelper(
              `set -eu; rm -rf ${shellQuote(`/store/${marker.namespace}/data`)}; mkdir -p ${shellQuote(`/store/${marker.namespace}/data`)}; chown 100:101 ${shellQuote(`/store/${marker.namespace}/data`)}`,
              [{ source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" }],
            );
          }
          yield* options.fs
            .remove(options.path.join(options.instanceRoot, ".supabase-database-ready.json"), {
              force: true,
            })
            .pipe(Effect.mapError((cause) => errorFor("reset", cause)));
          yield* writeMarker({ ...marker, initialized: false });
        }).pipe(Effect.mapError((cause) => errorFor("reset", cause))),
      );
      const destroyData = Effect.fn("DockerDatabaseStorage.destroyData")((_version: string) =>
        Effect.gen(function* () {
          const present = yield* getMarkerIfPresent;
          const markerOption = Option.isSome(present) ? present : yield* getMarkerForRemoval;
          if (Option.isNone(markerOption)) return;
          const marker = markerOption.value;
          if (marker.backend === "host") {
            yield* runHelper(
              `set -eu; rm -rf /instance/data /instance/.supabase-restore-* /instance/.supabase-database-ready.json`,
              snapshotPaths(marker).mounts,
            );
            yield* removeHelper();
          } else {
            yield* validateDockerMarkerIdentity(marker);
            if (marker.volume === undefined)
              return yield* errorFor("destroy", "Recorded Docker storage volume is missing");
            const volumeExists = yield* engineCommand(["volume", "inspect", marker.volume]).pipe(
              Effect.as(true),
              Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                /no such volume/iu.test(cause.message) ? Effect.succeed(false) : Effect.fail(cause),
              ),
            );
            if (volumeExists)
              yield* runHelper(`set -eu; rm -rf ${shellQuote(`/store/${marker.namespace}`)}`, [
                { source: marker.volume, target: "/store", readOnly: false, type: "volume" },
              ]);
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
      const descriptorDigest = (version: string, key: string) =>
        encodeIdentity({
          format: "supabase-database-snapshot-v1",
          version,
          runtime: options.runtime,
          platform: process.platform,
          arch: process.arch,
          profile: "supabase",
          key,
        }).pipe(
          Effect.mapError((cause) => errorFor("snapshot", cause)),
          Effect.flatMap(hash),
        );
      const saveSnapshot = Effect.fn("DockerDatabaseStorage.saveSnapshot")(
        (version: string, key: string) =>
          Effect.gen(function* () {
            yield* selected;
            const store = yield* getMarker;
            if (!store.initialized)
              return yield* errorFor("snapshot", "Database is not initialized");
            const readyPath = options.path.join(
              options.instanceRoot,
              ".supabase-database-ready.json",
            );
            if (
              !(yield* options.fs
                .exists(readyPath)
                .pipe(Effect.mapError((cause) => errorFor("snapshot", cause))))
            )
              return yield* errorFor("snapshot", "Database is not ready");
            const ready = yield* options.fs
              .readFileString(readyPath)
              .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReadyMarker))));
            if (ready.version !== version || ready.runtime !== options.runtime)
              return yield* errorFor(
                "snapshot",
                "Database readiness marker does not match the requested configuration",
              );
            const digest = yield* descriptorDigest(version, key);
            const paths = snapshotPaths(store);
            const root = paths.root;
            const source = paths.source;
            const target = `${root}/entries/${digest}`;
            const token = yield* options.crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => errorFor("snapshot", cause)),
            );
            const stage = `${root}/stages/${digest}-${token}`;
            const descriptor = yield* encodeDescriptor({
              format: "supabase-database-snapshot-v1",
              version,
              runtime: options.runtime,
              platform: process.platform,
              arch: process.arch,
              profile: "supabase",
              keyDigest: digest,
            });
            const cacheOwnership =
              store.backend === "host"
                ? `; owner=$(stat -c "%u:%g" /cache); mkdir -p /cache/stack-database-snapshots-helper; chown "$owner" /cache/stack-database-snapshots-helper; chown -R "$owner" ${root}`
                : "";
            yield* runHelper(
              `set -eu; mkdir -p ${root}; flock -x -w 120 ${shellQuote(`${root}/.lock`)} sh -eu -c ${shellQuote(`set -eu; mkdir -p ${root}/entries ${root}/stages; find ${root}/stages -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; find ${root}/entries -mindepth 1 -maxdepth 1 -name '*.retired' -exec rm -rf -- {} +; trap 'rm -rf ${stage}${cacheOwnership}' EXIT; if [ -e ${source}/postmaster.pid ]; then echo 'Cannot save a running database snapshot' >&2; exit 1; fi; if [ ! -f ${source}/PG_VERSION ]; then echo 'Cannot save snapshot: PG_VERSION is missing' >&2; exit 1; fi; actual=$(cat ${source}/PG_VERSION); if [ "$actual" != ${shellQuote(majorVersion(version))} ]; then echo 'Cannot save snapshot: PostgreSQL major does not match requested version' >&2; exit 1; fi; bad=$(find ${source} \\( ! -type f ! -type d \\) -print -quit); if [ -n "$bad" ]; then echo "Cannot save snapshot: unsupported filesystem entry $bad" >&2; exit 1; fi; rm -rf ${stage}; mkdir -p ${stage}; cp -a --reflink=auto ${source} ${stage}/data; printf '%s' ${shellQuote(descriptor)} > ${stage}/descriptor.json; if [ -e ${target} ]; then rm -rf ${target}.retired; mv ${target} ${target}.retired; if ! mv ${stage} ${target}; then mv ${target}.retired ${target}; exit 1; fi; else mv ${stage} ${target}; fi; rm -rf ${target}.retired; touch ${target}; find ${root}/entries -mindepth 1 -maxdepth 1 -type d ! -name ${digest} ! -name '*.retired' -printf '%T@ %p\\n' | sort -rn | tail -n +3 | cut -d' ' -f2- | xargs -r rm -rf`)}; rm -rf ${shellQuote(stage)}`,
              paths.mounts,
            );
          }).pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
      );
      const restoreSnapshot = Effect.fn("DockerDatabaseStorage.restoreSnapshot")(
        (version: string, key: string) =>
          Effect.gen(function* () {
            yield* selected;
            const store = yield* getMarker;
            const digest = yield* descriptorDigest(version, key);
            const paths = snapshotPaths(store);
            const root = paths.root;
            const source = `${root}/entries/${digest}`;
            const data = paths.source;
            const token = yield* options.crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => errorFor("snapshot", cause)),
            );
            const stage =
              store.backend === "host"
                ? `/instance/.supabase-restore-${digest}`
                : `${root}/stages/restore-${digest}-${token}`;
            const descriptor = yield* encodeDescriptor({
              format: "supabase-database-snapshot-v1",
              version,
              runtime: options.runtime,
              platform: process.platform,
              arch: process.arch,
              profile: "supabase",
              keyDigest: digest,
            });
            const targetSetup = store.initialized ? `test -d ${data}` : `mkdir -p ${data}`;
            const cacheOwnership =
              store.backend === "host"
                ? `; owner=$(stat -c "%u:%g" /cache); mkdir -p /cache/stack-database-snapshots-helper; chown "$owner" /cache/stack-database-snapshots-helper; chown -R "$owner" ${root}`
                : "";
            const result = yield* runHelper(
              `set -eu; mkdir -p ${root}; flock -x -w 120 ${shellQuote(`${root}/.lock`)} sh -eu -c ${shellQuote(`set -eu; mkdir -p ${root}/entries ${root}/stages; find ${root}/stages -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; find ${root}/entries -mindepth 1 -maxdepth 1 -name '*.retired' -exec rm -rf -- {} +; trap 'rm -rf ${stage}${cacheOwnership}' EXIT; if ! ${targetSetup}; then echo 'Initialized restore target data directory is missing' >&2; exit 1; fi; bad=$(find ${data} -mindepth 1 -print -quit); if [ -n "$bad" ]; then echo NONEMPTY; exit 0; fi; if [ ! -d ${source} ]; then echo MISS; exit 0; fi; if [ ! -f ${source}/descriptor.json ]; then echo 'Snapshot descriptor is missing' >&2; exit 1; fi; actual=$(cat ${source}/descriptor.json); expected=${shellQuote(descriptor)}; if [ "$actual" != "$expected" ]; then echo 'Snapshot descriptor does not match requested identity' >&2; exit 1; fi; bad=$(find ${source}/data \\( ! -type f ! -type d \\) -print -quit); if [ -n "$bad" ]; then echo "Snapshot contains unsupported filesystem entry $bad" >&2; exit 1; fi; if [ -e ${source}/data/postmaster.pid ]; then echo 'Snapshot contains postmaster.pid' >&2; exit 1; fi; rm -rf ${stage}; cp -a --reflink=auto ${source}/data ${stage}; actual=$(cat ${stage}/PG_VERSION); if [ "$actual" != ${shellQuote(majorVersion(version))} ]; then echo 'Snapshot PostgreSQL major does not match requested version' >&2; exit 1; fi; ${store.backend === "host" ? `chown -R 100:101 ${stage};` : ""} rmdir ${data}; mv ${stage} ${data}; touch ${source}; echo HIT`)}; rm -rf ${shellQuote(stage)}`,
              paths.mounts,
            );
            if (result === "MISS") return false;
            if (result === "NONEMPTY")
              return yield* errorFor("restore", "Restore target data directory must be empty");
            if (result !== "HIT")
              return yield* errorFor("restore", "Docker snapshot restore did not publish");
            yield* publishReadyMarker(version);
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

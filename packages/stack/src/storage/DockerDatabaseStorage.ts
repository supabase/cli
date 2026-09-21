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

const HELPER_IMAGE =
  "docker.io/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

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
              if (present)
                return yield* options.fs.readFileString(markerPath).pipe(
                  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Marker))),
                  Effect.flatMap(validateMarker),
                  Effect.mapError((cause) => errorFor("marker", cause)),
                );
              yield* options.fs
                .makeDirectory(options.cacheRoot, { recursive: true })
                .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
              const cacheRoot = yield* options.fs
                .realPath(options.cacheRoot)
                .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
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
                cacheNamespace: `cache-${(yield* hash(cacheRoot)).slice(0, 32)}`,
                initialized,
              };
              const encoded = yield* encodeMarker(value);
              yield* options.fs
                .writeFileString(markerPath, encoded, { mode: 0o600 })
                .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
              return value;
            }
            const daemonId = yield* engineCommand(["info", "--format", "{{.ID}}"]);
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
            const canonicalStateRoot = yield* options.fs
              .realPath(stateRoot)
              .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
            yield* options.fs
              .makeDirectory(options.cacheRoot, { recursive: true })
              .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
            const canonicalCacheRoot = yield* options.fs
              .realPath(options.cacheRoot)
              .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
            const stateDigest = yield* hash(`${canonicalStateRoot}\0${daemonId.trim()}`);
            const cacheDigest = yield* hash(canonicalCacheRoot);
            const volume = `supabase-db-${stateDigest.slice(0, 32)}`;
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
                if (validMarker.daemonId !== daemonId.trim())
                  return yield* errorFor(
                    "data",
                    "Recorded Docker database storage does not match this daemon",
                  );
                if (validMarker.volume === undefined)
                  return yield* errorFor("data", "Recorded Docker storage volume is missing");
                const volume = validMarker.volume;
                yield* engineCommand(["volume", "inspect", volume]).pipe(
                  Effect.catchTag("DockerDatabaseStorageError", (cause) =>
                    !validMarker.initialized && /(?:no such volume|not found)/iu.test(cause.message)
                      ? engineCommand([
                          "volume",
                          "create",
                          "--label",
                          "com.supabase.stack-managed=true",
                          "--label",
                          `com.supabase.stack-state-root=${stateDigest}`,
                          volume,
                        ]).pipe(Effect.asVoid)
                      : Effect.fail(cause),
                  ),
                );
                return validMarker;
              }
              return validMarker;
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
                  cacheNamespace: `cache-${cacheDigest.slice(0, 32)}`,
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
            const backend = clientMajor >= 26 && serverMajor >= 26 ? "docker" : "host";
            const value: Marker = {
              backend,
              ...(backend === "docker" ? { volume, daemonId: daemonId.trim() } : {}),
              namespace: dataNamespace,
              cacheNamespace: `cache-${cacheDigest.slice(0, 32)}`,
              initialized: false,
            };
            if (backend === "docker")
              yield* engineCommand([
                "volume",
                "create",
                "--label",
                "com.supabase.stack-managed=true",
                "--label",
                `com.supabase.stack-state-root=${stateDigest}`,
                volume,
              ]);
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
        removeHelper().pipe(Effect.catch((cause) => Effect.logError(cause))),
      );
      const acquireHelper = Effect.fn("DockerDatabaseStorage.acquireHelper")(
        (mounts: ReadonlyArray<DatabaseStorageMount>) =>
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
            yield* options.container.prepare(HELPER_IMAGE);
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
      );

      const runHelper = Effect.fn("DockerDatabaseStorage.helper")((
        command: string,
        mounts: ReadonlyArray<DatabaseStorageMount>,
      ): Effect.Effect<string, DockerDatabaseStorageError> => {
        const cleanupAfterFailure = Effect.gen(function* () {
          if ((yield* Ref.get(helperId)) === undefined) return;
          yield* Ref.set(helperCleanupPending, true);
          yield* removeHelper();
        });
        const operation = Effect.uninterruptibleMask((restore) =>
          restore(
            Effect.gen(function* () {
              const id = yield* acquireHelper(mounts);
              return yield* engineCommand(["exec", id, "/bin/sh", "-c", command]);
            }),
          ).pipe(
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
              yield* runHelper(
                `set -eu; if [ ! -f ${shellQuote(`/store/${marker.namespace}/data/PG_VERSION`)} ]; then echo 'Database readiness requires PG_VERSION' >&2; exit 1; fi; actual=$(cat ${shellQuote(`/store/${marker.namespace}/data/PG_VERSION`)}); if [ "$actual" != ${shellQuote(majorVersion(version))} ]; then echo 'Database PostgreSQL major does not match requested version' >&2; exit 1; fi`,
                [
                  {
                    source: marker.volume ?? "",
                    target: "/store",
                    readOnly: false,
                    type: "volume",
                  },
                ],
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
            const daemonId = yield* engineCommand(["info", "--format", "{{.ID}}"]).pipe(
              Effect.map((value) => value.trim()),
            );
            if (marker.daemonId !== daemonId)
              return yield* errorFor(
                "destroy",
                "Recorded Docker database storage belongs to another daemon; switch back to the original Docker context before destroying it",
              );
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
            yield* runHelper(
              `set -eu; mkdir -p ${root}; flock -x -w 120 ${shellQuote(`${root}/.lock`)} sh -eu -c ${shellQuote(`set -eu; mkdir -p ${root}/entries ${root}/stages; find ${root}/stages -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; find ${root}/entries -mindepth 1 -maxdepth 1 -name '*.retired' -exec rm -rf -- {} +; trap 'rm -rf ${stage}' EXIT; if [ -e ${source}/postmaster.pid ]; then echo 'Cannot save a running database snapshot' >&2; exit 1; fi; if [ ! -f ${source}/PG_VERSION ]; then echo 'Cannot save snapshot: PG_VERSION is missing' >&2; exit 1; fi; actual=$(cat ${source}/PG_VERSION); if [ "$actual" != ${shellQuote(majorVersion(version))} ]; then echo 'Cannot save snapshot: PostgreSQL major does not match requested version' >&2; exit 1; fi; bad=$(find ${source} \\( ! -type f ! -type d \\) -print -quit); if [ -n "$bad" ]; then echo "Cannot save snapshot: unsupported filesystem entry $bad" >&2; exit 1; fi; rm -rf ${stage}; mkdir -p ${stage}; cp -a --reflink=auto ${source} ${stage}/data; printf '%s' ${shellQuote(descriptor)} > ${stage}/descriptor.json; if [ -e ${target} ]; then rm -rf ${target}.retired; mv ${target} ${target}.retired; if ! mv ${stage} ${target}; then mv ${target}.retired ${target}; exit 1; fi; else mv ${stage} ${target}; fi; rm -rf ${target}.retired; touch ${target}; find ${root}/entries -mindepth 1 -maxdepth 1 -type d ! -name ${digest} ! -name '*.retired' -printf '%T@ %p\\n' | sort -rn | tail -n +3 | cut -d' ' -f2- | xargs -r rm -rf`)}; rm -rf ${shellQuote(stage)}`,
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
            const result = yield* runHelper(
              `set -eu; mkdir -p ${root}; flock -x -w 120 ${shellQuote(`${root}/.lock`)} sh -eu -c ${shellQuote(`set -eu; mkdir -p ${root}/entries ${root}/stages; find ${root}/stages -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; find ${root}/entries -mindepth 1 -maxdepth 1 -name '*.retired' -exec rm -rf -- {} +; if ! ${targetSetup}; then echo 'Initialized restore target data directory is missing' >&2; exit 1; fi; trap 'rm -rf ${stage}' EXIT; bad=$(find ${data} -mindepth 1 -print -quit); if [ -n "$bad" ]; then echo NONEMPTY; exit 0; fi; if [ ! -d ${source} ]; then echo MISS; exit 0; fi; if [ ! -f ${source}/descriptor.json ]; then echo 'Snapshot descriptor is missing' >&2; exit 1; fi; actual=$(cat ${source}/descriptor.json); expected=${shellQuote(descriptor)}; if [ "$actual" != "$expected" ]; then echo 'Snapshot descriptor does not match requested identity' >&2; exit 1; fi; bad=$(find ${source}/data \\( ! -type f ! -type d \\) -print -quit); if [ -n "$bad" ]; then echo "Snapshot contains unsupported filesystem entry $bad" >&2; exit 1; fi; if [ -e ${source}/data/postmaster.pid ]; then echo 'Snapshot contains postmaster.pid' >&2; exit 1; fi; rm -rf ${stage}; cp -a --reflink=auto ${source}/data ${stage}; actual=$(cat ${stage}/PG_VERSION); if [ "$actual" != ${shellQuote(majorVersion(version))} ]; then echo 'Snapshot PostgreSQL major does not match requested version' >&2; exit 1; fi; rmdir ${data}; mv ${stage} ${data}; touch ${source}; echo HIT`)}; rm -rf ${shellQuote(stage)}`,
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

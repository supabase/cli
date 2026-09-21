import {
  Crypto,
  Effect,
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
  "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const Marker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  volume: Schema.optionalKey(Schema.String),
  namespace: Schema.String,
  cacheNamespace: Schema.String,
  daemonId: Schema.optionalKey(Schema.String),
  initialized: Schema.Boolean,
});
type Marker = Schema.Schema.Type<typeof Marker>;

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
      const selected = yield* Effect.cached(
        Effect.gen(function* () {
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
                Effect.mapError((cause) => errorFor("marker", cause)),
              );
            const cacheRoot = yield* options.fs
              .realPath(options.cacheRoot)
              .pipe(Effect.mapError((cause) => errorFor("identity", cause)));
            const value: Marker = {
              backend: "host",
              namespace: dataNamespace,
              cacheNamespace: `cache-${(yield* hash(cacheRoot)).slice(0, 32)}`,
              initialized: false,
            };
            yield* options.fs
              .writeFileString(markerPath, JSON.stringify(value), { mode: 0o600 })
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
            if (marker.value.namespace !== dataNamespace)
              return yield* errorFor(
                "data",
                "Recorded Docker database namespace does not match this instance",
              );
            if (marker.value.backend === "docker") {
              if (marker.value.daemonId !== daemonId.trim())
                return yield* errorFor(
                  "data",
                  "Recorded Docker database storage does not match this daemon",
                );
              if (marker.value.volume === undefined)
                return yield* errorFor("data", "Recorded Docker storage volume is missing");
              yield* engineCommand(["volume", "inspect", marker.value.volume]);
              return marker.value;
            }
            return marker.value;
          }
          const hostData = options.path.join(options.instanceRoot, "data");
          if (
            yield* options.fs
              .exists(hostData)
              .pipe(Effect.mapError((cause) => errorFor("data", cause)))
          ) {
            const entries = yield* options.fs
              .readDirectory(hostData)
              .pipe(Effect.mapError((cause) => errorFor("data", cause)));
            if (entries.length > 0) {
              const value: Marker = {
                backend: "host",
                namespace: dataNamespace,
                cacheNamespace: `cache-${cacheDigest.slice(0, 32)}`,
                initialized: true,
              };
              yield* options.fs
                .writeFileString(markerPath, JSON.stringify(value), { mode: 0o600 })
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
            .writeFileString(markerPath, JSON.stringify(value), { mode: 0o600 })
            .pipe(Effect.mapError((cause) => errorFor("marker", cause)));
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
        Effect.gen(function* () {
          const current = yield* Ref.get(helperId);
          if (current !== undefined) {
            yield* engineCommand(["rm", "-f", current]);
            yield* Ref.set(helperId, undefined);
          }
        }),
      );
      yield* Scope.addFinalizer(
        ownerScope,
        removeHelper().pipe(Effect.catch((cause) => Effect.logError(cause))),
      );
      const acquireHelper = Effect.fn("DockerDatabaseStorage.acquireHelper")(
        (mounts: ReadonlyArray<DatabaseStorageMount>) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(helperId);
            if (current !== undefined) return current;
            if (options.container === undefined)
              return yield* errorFor("helper", "Container runtime is unavailable");
            yield* options.container.prepare(HELPER_IMAGE);
            const created = yield* engineCommand([
              "run",
              "-d",
              "--init",
              "--label",
              "com.supabase.stack-managed=true",
              ...mountArgs(mounts),
              HELPER_IMAGE,
              "/bin/sh",
              "-c",
              "trap : TERM INT; while :; do sleep 3600; done",
            ]);
            if (!/^[a-f0-9]{12,64}$/u.test(created))
              return yield* errorFor("helper", "Docker returned an invalid helper identity");
            yield* Ref.set(helperId, created);
            return created;
          }),
      );

      const runHelper = Effect.fn("DockerDatabaseStorage.helper")((
        command: string,
        mounts: ReadonlyArray<DatabaseStorageMount>,
      ): Effect.Effect<string, DockerDatabaseStorageError> => {
        const operation = Effect.gen(function* () {
          const id = yield* acquireHelper(mounts);
          return yield* engineCommand(["exec", id, "/bin/sh", "-c", command]);
        })
          .pipe(
            Effect.catchCause((cause) =>
              removeHelper().pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          )
          .pipe(Effect.mapError((cause) => errorFor("mount", cause)));
        return operationLock
          .withPermit(operation)
          .pipe(Effect.mapError((cause) => errorFor("helper", cause)));
      });

      const getMarker = Effect.gen(function* () {
        const marker = yield* options.fs
          .readFileString(markerPath)
          .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Marker))));
        return marker;
      });
      const writeMarker = (marker: Marker) =>
        options.fs.writeFileString(markerPath, JSON.stringify(marker), { mode: 0o600 });
      const setup = Effect.fn("DockerDatabaseStorage.prepare")((version: string) =>
        Effect.gen(function* () {
          yield* selected;
          const marker = yield* getMarker;
          if (marker.backend === "host") {
            yield* options.fs.makeDirectory(options.path.join(options.instanceRoot, "data"), {
              recursive: true,
              mode: 0o700,
            });
            return;
          }
          const store = `/store/${marker.namespace}`;
          const cache = `/store/${marker.cacheNamespace}`;
          yield* runHelper(
            `set -eu; mkdir -p ${shellQuote(`${store}/data`)} ${shellQuote(`${cache}/entries`)} ${shellQuote(`${cache}/stages`)}; chown -R 100:101 ${shellQuote(store)}; test -f ${shellQuote(`${store}/data/PG_VERSION`)} || true`,
            [{ source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" }],
          );
          if (marker.initialized) {
            const major = yield* runHelper(
              `set -eu; test -f ${shellQuote(`${store}/data/PG_VERSION`)}; cat ${shellQuote(`${store}/data/PG_VERSION`)}`,
              [{ source: marker.volume ?? "", target: "/store", readOnly: true, type: "volume" }],
            );
            if (major.trim() !== majorVersion(version))
              return yield* errorFor(
                "prepare",
                "Initialized PostgreSQL major does not match the requested configuration",
              );
          }
        }).pipe(Effect.mapError((cause) => errorFor("prepare", cause))),
      );
      const majorVersion = (version: string) => version.split(".")[0] ?? version;

      const mount = (version: string) =>
        Effect.flatMap(selected, () => getMarker)
          .pipe(
            Effect.flatMap((marker) =>
              (marker.initialized ? Effect.void : setup(version)).pipe(
                Effect.andThen(
                  Effect.succeed(
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
                ),
              ),
            ),
          )
          .pipe(Effect.mapError((cause) => errorFor("mount", cause)));
      const markInitialized = Effect.fn("DockerDatabaseStorage.markInitialized")(
        (version: string) =>
          Effect.gen(function* () {
            const marker = yield* getMarker;
            if (marker.backend === "docker") {
              yield* runHelper(
                `set -eu; test -f ${shellQuote(`/store/${marker.namespace}/data/PG_VERSION`)}; test "$(cat ${shellQuote(`/store/${marker.namespace}/data/PG_VERSION`)})" = ${shellQuote(majorVersion(version))}`,
                [{ source: marker.volume ?? "", target: "/store", readOnly: true, type: "volume" }],
              );
            }
            yield* writeMarker({ ...marker, initialized: true });
          }).pipe(Effect.mapError((cause) => errorFor("ready", cause))),
      );
      const removeData = Effect.fn("DockerDatabaseStorage.removeData")((_version: string) =>
        Effect.gen(function* () {
          const marker = yield* getMarker;
          if (marker.backend === "host") {
            yield* options.fs.remove(options.path.join(options.instanceRoot, "data"), {
              recursive: true,
              force: true,
            });
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
          const marker = yield* getMarker;
          if (marker.backend === "host") {
            yield* options.fs.remove(options.path.join(options.instanceRoot, "data"), {
              recursive: true,
              force: true,
            });
            yield* removeHelper();
          } else {
            yield* runHelper(`set -eu; rm -rf ${shellQuote(`/store/${marker.namespace}`)}`, [
              { source: marker.volume ?? "", target: "/store", readOnly: false, type: "volume" },
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
              root: `/cache/stack-database-snapshots/${marker.cacheNamespace}`,
              source: "/instance/data",
              mounts: [
                { source: options.instanceRoot, target: "/instance", readOnly: false as const },
                { source: options.cacheRoot, target: "/cache", readOnly: false as const },
              ],
            };
      const descriptorDigest = (version: string, key: string) =>
        hash(
          JSON.stringify({
            format: "supabase-database-snapshot-v1",
            version,
            runtime: options.runtime,
            platform: process.platform,
            arch: process.arch,
            profile: "supabase",
            key,
          }),
        );
      const saveSnapshot = Effect.fn("DockerDatabaseStorage.saveSnapshot")(
        (version: string, key: string) =>
          Effect.gen(function* () {
            const store = yield* getMarker;
            const digest = yield* descriptorDigest(version, key);
            const paths = snapshotPaths(store);
            const root = paths.root;
            const source = paths.source;
            const target = `${root}/entries/${digest}`;
            const token = yield* options.crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => errorFor("snapshot", cause)),
            );
            const stage = `${root}/stages/${digest}-${token}`;
            const descriptor = JSON.stringify({
              format: "supabase-database-snapshot-v1",
              version,
              runtime: options.runtime,
              platform: process.platform,
              arch: process.arch,
              profile: "supabase",
              keyDigest: digest,
            });
            yield* runHelper(
              `set -eu; mkdir -p ${root}/entries ${root}/stages; flock -x -w 120 ${shellQuote(`${root}/.lock`)} sh -eu -c ${shellQuote(`set -eu; trap 'rm -rf ${stage}' EXIT; test ! -e ${source}/postmaster.pid; test -f ${source}/PG_VERSION; test "$(cat ${source}/PG_VERSION)" = ${majorVersion(version)}; bad=$(find ${source} \\( ! -type f ! -type d \\) -print -quit); test -z "$bad"; rm -rf ${stage}; mkdir -p ${stage}; cp -a --reflink=auto ${source} ${stage}/data; printf '%s' ${shellQuote(descriptor)} > ${stage}/descriptor.json; if [ -e ${target} ]; then mv ${target} ${target}.retired; fi; mv ${stage} ${target}; rm -rf ${target}.retired; find ${root}/entries -mindepth 1 -maxdepth 1 -type d ! -name ${digest} -printf '%T@ %p\\n' | sort -rn | tail -n +3 | cut -d' ' -f2- | xargs -r rm -rf`)}; rm -rf ${shellQuote(stage)}`,
              paths.mounts,
            );
          }).pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
      );
      const restoreSnapshot = Effect.fn("DockerDatabaseStorage.restoreSnapshot")(
        (version: string, key: string) =>
          Effect.gen(function* () {
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
            const descriptor = JSON.stringify({
              format: "supabase-database-snapshot-v1",
              version,
              runtime: options.runtime,
              platform: process.platform,
              arch: process.arch,
              profile: "supabase",
              keyDigest: digest,
            });
            const result = yield* runHelper(
              `set -eu; mkdir -p ${root}/entries ${root}/stages; flock -x -w 120 ${shellQuote(`${root}/.lock`)} sh -eu -c ${shellQuote(`set -eu; trap 'rm -rf ${stage}' EXIT; if find ${data} -mindepth 1 -print -quit | grep -q .; then echo NONEMPTY; exit 0; fi; if [ ! -d ${source} ]; then echo MISS; exit 0; fi; test -f ${source}/descriptor.json; actual=$(cat ${source}/descriptor.json); expected=${shellQuote(descriptor)}; if [ "$actual" != "$expected" ]; then case "$actual" in *\\"format\\":\\"supabase-database-snapshot-v1\\"*) echo MISS; exit 0;; *) exit 1;; esac; fi; bad=$(find ${source}/data \\( ! -type f ! -type d \\) -print -quit); test -z "$bad"; test ! -e ${source}/data/postmaster.pid; rm -rf ${stage}; cp -a --reflink=auto ${source}/data ${stage}; test "$(cat ${stage}/PG_VERSION)" = ${majorVersion(version)}; rmdir ${data}; mv ${stage} ${data}; touch ${source}; echo HIT`)}; rm -rf ${shellQuote(stage)}`,
              paths.mounts,
            );
            if (result === "MISS") return false;
            if (result === "NONEMPTY")
              return yield* errorFor("restore", "Restore target data directory must be empty");
            if (result !== "HIT")
              return yield* errorFor("restore", "Docker snapshot restore did not publish");
            yield* writeMarker({ ...store, initialized: true });
            return true;
          }).pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
      );
      return {
        prepare: setup,
        mount,
        markInitialized,
        removeData,
        destroyData,
        saveSnapshot,
        restoreSnapshot,
      };
    }),
);

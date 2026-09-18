import { PgClient } from "@effect/sql-pg";
import {
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient } from "effect/unstable/http";
import {
  prepareNativeArtifact,
  postgresVersion,
  resolveArtifact,
  type PreparedNativeArtifact,
} from "../Artifacts.ts";
import {
  makeContainerRuntime,
  type ContainerProcess,
  type ContainerRuntime,
} from "../runtime/Container.ts";
import { DatabaseBootstrapError, runDatabaseBootstrap } from "../runtime/DatabaseBootstrap.ts";
import {
  ensureInternalDatabase,
  makeDatabaseSessionFromSqlClient,
} from "../runtime/PostgresDatabaseSession.ts";
import {
  ServiceError,
  ServiceLaunchError,
  type RuntimeSession,
  type ServiceDefinition,
  type ServiceInstanceContext,
} from "../Service.ts";
import {
  defaultNativeProcessLauncher,
  spawnNativeProcess,
  type NativeProcess,
} from "../runtime/NativeProcess.ts";
import type { StackId } from "../identity/StackId.ts";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";

export const DatabaseConfig = Schema.Struct({
  version: Schema.String,
  databasePassword: Schema.Redacted(Schema.String),
  jwtSecret: Schema.Redacted(Schema.String),
  jwtExpiry: Schema.Finite,
  settings: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  ),
});

const DatabaseReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  profile: Schema.Literal("supabase"),
});

export interface DatabaseConfig extends Schema.Schema.Type<typeof DatabaseConfig> {}

export const DatabaseEndpoints = Schema.Struct({ sql: Schema.optionalKey(EndpointIntent) });
export interface DatabaseEndpoints extends Schema.Schema.Type<typeof DatabaseEndpoints> {}
export const DatabaseCreation = serviceCreation("database", DatabaseConfig, DatabaseEndpoints);
export interface DatabaseCreation extends Schema.Schema.Type<typeof DatabaseCreation> {}

export type DatabaseRuntime = "native" | "docker" | "podman";

export type BackendEndpoint =
  | { readonly kind: "unix"; readonly path: string; readonly port: 5432 }
  | { readonly kind: "tcp"; readonly host: "127.0.0.1"; readonly port: number };

interface DatabaseLog {
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DatabaseOptions {
  readonly stackId: StackId | string;
  readonly instanceId: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: DatabaseRuntime;
}

export interface DatabaseComponent {
  readonly definition: ServiceDefinition<DatabaseConfig>;
  readonly endpoint: Effect.Effect<BackendEndpoint, DatabaseError>;
  readonly logs: Stream.Stream<DatabaseLog, DatabaseError>;
}

const errorFor = (operation: string, cause: unknown): ServiceError =>
  cause instanceof ServiceError
    ? cause
    : new ServiceError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const databaseError = (operation: string, cause: unknown): DatabaseError =>
  new DatabaseError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const processExit = <E extends { readonly message: string }>(
  exitCode: Effect.Effect<number, E>,
): Effect.Effect<Exit.Exit<void, ServiceError>> =>
  exitCode.pipe(
    Effect.flatMap((code) =>
      Number(code) === 0
        ? Effect.void
        : Effect.fail(
            new ServiceError({
              operation: "exit",
              message: `PostgreSQL exited with code ${String(code)}`,
            }),
          ),
    ),
    Effect.mapError((cause) => errorFor("exit", cause)),
    Effect.exit,
  );

const reconcileContainerPassword = Effect.fn("Database.reconcileContainerPassword")(
  (
    engine: "docker" | "podman",
    id: string,
    password: Redacted.Redacted<string>,
    spawner: ChildProcessSpawnerService["Service"],
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            engine,
            [
              "exec",
              "-i",
              id,
              "/opt/postgres/bin/psql",
              "-h",
              "/tmp",
              "-p",
              "5432",
              "-U",
              "supabase_admin",
              "-d",
              "postgres",
              "-X",
              "-v",
              "ON_ERROR_STOP=1",
            ],
            { stdin: "pipe" },
          ),
        );
        const statement = `BEGIN; SET LOCAL log_statement = 'none'; SET LOCAL log_min_error_statement = 'panic'; SET LOCAL log_min_duration_statement = -1; SET LOCAL log_min_duration_sample = -1; SET LOCAL standard_conforming_strings = on; ALTER ROLE supabase_admin PASSWORD '${Redacted.value(password).replaceAll("'", "''")}'; COMMIT;`;
        const [, , , code] = yield* Effect.all(
          [
            Stream.make(new TextEncoder().encode(statement)).pipe(Stream.run(child.stdin)),
            child.stdout.pipe(Stream.runDrain),
            child.stderr.pipe(Stream.runDrain),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0)
          return yield* errorFor("health", "Local database credential setup has not succeeded");
      }),
    ).pipe(
      Effect.mapError(() => errorFor("health", "Local database credential setup failed")),
      Effect.retry(Schedule.spaced("250 millis")),
    ),
);

const health = Effect.fn("Database.health")((
  endpoint: BackendEndpoint,
  config: DatabaseConfig,
  reconcile: Effect.Effect<void, ServiceError>,
  context: {
    readonly fs: FileSystem.FileSystem;
    readonly instanceRoot: string;
    readonly version: string;
    readonly runtime: DatabaseRuntime;
  },
): Effect.Effect<void, ServiceError> => {
  const host = endpoint.kind === "unix" ? endpoint.path : endpoint.host;
  const probe = Effect.scoped(
    Effect.gen(function* () {
      const layer = yield* Layer.build(
        PgClient.layer({
          host,
          port: endpoint.port,
          database: "postgres",
          username: "supabase_admin",
          password: config.databasePassword,
          connectTimeout: "2 seconds",
        }),
      );
      const client = Context.get(layer, PgClient.PgClient);
      yield* client.unsafe("SELECT 1");
    }),
  );
  const retryProbe = probe.pipe(Effect.retry(Schedule.spaced("250 millis")));
  return reconcile.pipe(
    Effect.andThen(retryProbe),
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const layer = yield* Layer.build(
            PgClient.layer({
              host,
              port: endpoint.port,
              database: "postgres",
              username: "supabase_admin",
              password: config.databasePassword,
              connectTimeout: "2 seconds",
            }),
          );
          const client = Context.get(layer, PgClient.PgClient);
          const session = makeDatabaseSessionFromSqlClient(client);
          const openInternal = Effect.gen(function* () {
            const internalLayer = yield* Layer.build(
              PgClient.layer({
                host,
                port: endpoint.port,
                database: "_supabase",
                username: "supabase_admin",
                password: config.databasePassword,
                connectTimeout: "2 seconds",
              }),
            );
            return makeDatabaseSessionFromSqlClient(Context.get(internalLayer, PgClient.PgClient));
          }).pipe(
            Effect.mapError(
              (cause) =>
                new DatabaseBootstrapError({
                  message: "Unable to connect to the internal database",
                  cause,
                }),
            ),
          );
          yield* ensureInternalDatabase(session, openInternal).pipe(
            Effect.mapError((cause) => errorFor("bootstrap", cause)),
          );
          yield* runDatabaseBootstrap(session, {
            databasePassword: config.databasePassword,
            jwtSecret: config.jwtSecret,
            jwtExpiry: config.jwtExpiry,
          }).pipe(Effect.mapError((cause) => errorFor("bootstrap", cause)));
          const readyMarker = yield* Schema.encodeEffect(
            Schema.fromJsonString(DatabaseReadyMarker),
          )({
            version: context.version,
            runtime: context.runtime,
            profile: "supabase",
          }).pipe(Effect.mapError((cause) => errorFor("bootstrap", cause)));
          const stage = yield* context.fs.makeTempDirectoryScoped({
            directory: context.instanceRoot,
            prefix: ".ready-",
          });
          yield* context.fs.writeFileString(`${stage}/marker`, readyMarker, { mode: 0o600 });
          yield* context.fs.rename(
            `${stage}/marker`,
            `${context.instanceRoot}/.supabase-database-ready.json`,
          );
        }),
      ),
    ),
    Effect.timeout("60 seconds"),
    Effect.mapError((cause) => errorFor("health", cause)),
  );
});

const publishLogs = Effect.fn("Database.publishLogs")((
  process: {
    readonly stdout: Stream.Stream<Uint8Array, unknown>;
    readonly stderr: Stream.Stream<Uint8Array, unknown>;
  },
  logs: PubSub.PubSub<DatabaseLog>,
  scope: Scope.Closeable,
): Effect.Effect<void> => {
  const drain = (stream: Stream.Stream<Uint8Array, unknown>, name: DatabaseLog["stream"]) =>
    stream.pipe(
      Stream.runForEach((bytes) => PubSub.publish(logs, { stream: name, bytes })),
      Effect.catch((cause) => Effect.logError(cause)),
    );
  return Effect.all(
    [
      Effect.forkIn(drain(process.stdout, "stdout"), scope),
      Effect.forkIn(drain(process.stderr, "stderr"), scope),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

const runtimeFromContainer = (process: ContainerProcess): RuntimeSession => ({
  health: Effect.void,
  exit: processExit(process.exitCode),
  stop: process.stop.pipe(Effect.mapError((cause) => errorFor("stop", cause))),
  remove: process.remove.pipe(Effect.mapError((cause) => errorFor("remove", cause))),
});

const ensureOwnedRoot = Effect.fn("Database.ensureOwnedRoot")((
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  stackId: string,
  instanceId: string,
): Effect.Effect<void, DatabaseError> => {
  const ownerFile = path.join(root, ".supabase-database-owner.json");
  const marker = JSON.stringify({ stackId, instanceId });
  return Effect.gen(function* () {
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => databaseError("data", cause)));
    const present = yield* fs
      .exists(ownerFile)
      .pipe(Effect.mapError((cause) => databaseError("data", cause)));
    if (present) {
      const existing = yield* fs
        .readFileString(ownerFile)
        .pipe(Effect.mapError((cause) => databaseError("data", cause)));
      if (existing !== marker)
        return yield* databaseError("data", "Database root belongs to another instance");
    } else {
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError((cause) => databaseError("data", cause)));
      if (entries.length > 0)
        return yield* databaseError("data", "Database root is non-empty and unmarked");
      yield* fs
        .writeFileString(ownerFile, marker, { mode: 0o600, flag: "wx" })
        .pipe(Effect.mapError((cause) => databaseError("data", cause)));
    }
  });
});

const removeOwnedRoot = Effect.fn("Database.removeOwnedRoot")((
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  stackId: string,
  instanceId: string,
  removeData: Effect.Effect<void, ServiceError>,
): Effect.Effect<void, ServiceError> => {
  const ownerFile = path.join(root, ".supabase-database-owner.json");
  const marker = JSON.stringify({ stackId, instanceId });
  return Effect.gen(function* () {
    const present = yield* fs
      .exists(ownerFile)
      .pipe(Effect.mapError((cause) => errorFor("destroy", cause)));
    if (!present) {
      if (yield* fs.exists(root).pipe(Effect.mapError((cause) => errorFor("destroy", cause))))
        return yield* errorFor("destroy", "Database root is unmarked");
      return;
    }
    const existing = yield* fs
      .readFileString(ownerFile)
      .pipe(Effect.mapError((cause) => errorFor("destroy", cause)));
    if (existing !== marker)
      return yield* errorFor("destroy", "Database root belongs to another instance");
    yield* removeData;
    yield* fs
      .remove(root, { recursive: true, force: true })
      .pipe(Effect.mapError((cause) => errorFor("destroy", cause)));
  });
});

const nativeProcess = (
  artifact: PreparedNativeArtifact,
  config: DatabaseConfig,
  dataPath: string,
  socketPath: string,
  settings: ReadonlyArray<string>,
  context: ServiceInstanceContext<DatabaseConfig>,
  stackId: string,
  instanceId: string,
  spawner: ChildProcessSpawnerService["Service"],
): Effect.Effect<NativeProcess, ServiceError> =>
  spawnNativeProcess(
    {
      executable: artifact.executable,
      args: [
        "-D",
        dataPath,
        "-p",
        "5432",
        "-c",
        "listen_addresses=",
        "-c",
        `unix_socket_directories=${socketPath}`,
        ...settings,
      ],
      env: {
        PGDATA: dataPath,
        POSTGRES_USER: "supabase_admin",
        POSTGRES_DB: "postgres",
        POSTGRES_PASSWORD: Redacted.value(config.databasePassword),
      },
      gracefulStopSignal: "SIGINT",
      gracefulStopTimeout: "15 seconds",
    },
    defaultNativeProcessLauncher(),
    { stackId, workloadId: instanceId },
  ).pipe(
    Scope.provide(context.scope),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.mapError((cause) => errorFor("launch", cause)),
  );

/** Creates a database component backed by one native or container PostgreSQL session. */
export const makeDatabase = (
  options: DatabaseOptions,
): Effect.Effect<
  DatabaseComponent,
  DatabaseError,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const client = yield* HttpClient.HttpClient;
    const logs = yield* PubSub.sliding<DatabaseLog>(256);
    const endpoint = yield* Ref.make<BackendEndpoint | undefined>(undefined);
    const prepared = yield* Ref.make<ReadonlyMap<string, PreparedNativeArtifact>>(new Map());
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(String(options.stackId)))
      return yield* databaseError("identity", "Invalid stack id");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(options.instanceId))
      return yield* databaseError("identity", "Invalid instance id");
    const instanceRoot = path.join(options.root, options.instanceId);
    yield* ensureOwnedRoot(fs, path, instanceRoot, String(options.stackId), options.instanceId);
    const container: ContainerRuntime | undefined =
      options.runtime === "native"
        ? undefined
        : yield* makeContainerRuntime({ engine: options.runtime });

    const dataCommand = Effect.fn("Database.containerFiles")(
      function* (version: string, args: ReadonlyArray<string>) {
        if (container === undefined) return "";
        const artifact = yield* resolveArtifact({
          service: "database",
          version: postgresVersion(version),
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* container.launchTool({
              image: artifact.image,
              stackId: String(options.stackId),
              instanceId: options.instanceId,
              entrypoint: "/usr/bin/busybox",
              args,
              env: {},
              mounts: [{ source: instanceRoot, target: "/instance", readOnly: false }],
            });
            return yield* Effect.acquireUseRelease(
              Effect.succeed(child),
              (child) =>
                Effect.gen(function* () {
                  const [, stdout, , code] = yield* Effect.all(
                    [
                      Stream.empty.pipe(Stream.run(child.stdin)),
                      child.stdout.pipe(
                        Stream.decodeText,
                        Stream.runFold(
                          () => "",
                          (text, chunk) => (text + chunk).slice(-65536),
                        ),
                      ),
                      child.stderr.pipe(Stream.runDrain),
                      child.exitCode,
                    ],
                    { concurrency: "unbounded" },
                  );
                  if (code !== 0)
                    return yield* errorFor("data", "Container filesystem operation failed");
                  return stdout;
                }),
              (child) => child.stop.pipe(Effect.andThen(child.remove)),
            );
          }),
        );
      },
      Effect.mapError((cause) => errorFor("data", cause)),
    );

    const prepareArtifact = Effect.fn("Database.prepareArtifact")((
      input: DatabaseConfig,
    ): Effect.Effect<void, ServiceError> => {
      const version = postgresVersion(input.version);
      if (!Number.isInteger(input.jwtExpiry) || input.jwtExpiry <= 0)
        return Effect.fail(
          new ServiceError({
            operation: "prepare",
            message: "jwtExpiry must be a positive integer",
          }),
        );
      const forbidden = new Set([
        "listen_addresses",
        "unix_socket_directories",
        "data_directory",
        "config_file",
        "hba_file",
        "external_pid_file",
        "port",
      ]);
      if (Object.keys(input.settings ?? {}).some((key) => forbidden.has(key.toLowerCase())))
        return Effect.fail(
          new ServiceError({
            operation: "prepare",
            message: "Database settings override managed isolation",
          }),
        );
      if (options.runtime === "native")
        return prepareNativeArtifact({ service: "database", version }, options.cacheRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.tap((artifact) =>
            Ref.update(prepared, (map) => new Map(map).set(version, artifact)),
          ),
          Effect.asVoid,
          Effect.mapError((cause) => errorFor("prepare", cause)),
        );
      const selectedContainer = container;
      if (selectedContainer === undefined)
        return Effect.fail(
          new ServiceError({ operation: "prepare", message: "Container runtime is unavailable" }),
        );
      return resolveArtifact({ service: "database", version }).pipe(
        Effect.flatMap((artifact) => selectedContainer.prepare(artifact.image)),
        Effect.mapError((cause) => errorFor("prepare", cause)),
      );
    });

    const prepare = Effect.fn("Database.prepare")(
      function* (input: DatabaseConfig) {
        const markerPath = path.join(instanceRoot, ".supabase-database-ready.json");
        const hasMarker = yield* fs.exists(markerPath);
        if (hasMarker) {
          const marker = yield* fs
            .readFileString(markerPath)
            .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DatabaseReadyMarker))));
          if (
            marker.version.split(".")[0] !== postgresVersion(input.version).split(".")[0] ||
            marker.runtime !== options.runtime
          )
            return yield* errorFor(
              "prepare",
              "Initialized database artifact/runtime does not match the requested configuration",
            );
        }
        const versionPath = path.join(instanceRoot, "data", "PG_VERSION");
        if (!hasMarker && options.runtime === "native" && (yield* fs.exists(versionPath))) {
          const initialized = (yield* fs.readFileString(versionPath)).trim();
          if (initialized !== postgresVersion(input.version).split(".")[0])
            return yield* errorFor(
              "prepare",
              "Initialized PostgreSQL major does not match the requested configuration",
            );
        }
        yield* prepareArtifact(input);
        if (!hasMarker && container !== undefined) {
          const initialized = (yield* dataCommand(input.version, [
            "sh",
            "-c",
            "if [ -f /instance/data/PG_VERSION ]; then /usr/bin/busybox cat /instance/data/PG_VERSION; fi",
          ])).trim();
          if (initialized !== "" && initialized !== postgresVersion(input.version).split(".")[0])
            return yield* errorFor(
              "prepare",
              "Initialized PostgreSQL major does not match the requested configuration",
            );
        }
      },
      Effect.mapError((cause) => errorFor("prepare", cause)),
    );

    const launch = Effect.fn("Database.launch")(
      (
        context: ServiceInstanceContext<DatabaseConfig>,
      ): Effect.Effect<RuntimeSession, ServiceError | ServiceLaunchError> =>
        Effect.gen(function* () {
          const config = { ...context.config, version: postgresVersion(context.config.version) };
          const dataPath = path.join(instanceRoot, "data");
          yield* fs
            .makeDirectory(dataPath, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
          const settings = Object.entries(config.settings ?? {}).flatMap(([key, value]) => [
            "-c",
            `${key}=${String(value)}`,
          ]);
          if (options.runtime === "native") {
            // PostgreSQL limits Unix socket paths to 103 bytes, independently of the user's state root.
            const socketPath = yield* Effect.acquireRelease(
              fs.makeTempDirectory({ directory: "/tmp", prefix: "supabase-pg-" }),
              (directory) =>
                fs
                  .remove(directory, { recursive: true, force: true })
                  .pipe(Effect.catch((cause) => Effect.logError(cause))),
            ).pipe(
              Scope.provide(context.scope),
              Effect.mapError((cause) => errorFor("launch", cause)),
            );
            const artifact = (yield* Ref.get(prepared)).get(config.version);
            if (artifact === undefined)
              return yield* errorFor("launch", `Artifact ${config.version} was not prepared`);
            const process = yield* nativeProcess(
              artifact,
              config,
              dataPath,
              socketPath,
              settings,
              context,
              String(options.stackId),
              options.instanceId,
              spawner,
            );
            const selectedEndpoint: BackendEndpoint = {
              kind: "unix",
              path: socketPath,
              port: 5432,
            };
            yield* Ref.set(endpoint, selectedEndpoint);
            yield* publishLogs(process, logs, context.scope);
            return {
              health: health(selectedEndpoint, config, Effect.void, {
                fs,
                instanceRoot,
                version: config.version,
                runtime: options.runtime,
              }),
              exit: processExit(process.exitCode),
              stop: process.kill.pipe(Effect.mapError((cause) => errorFor("stop", cause))),
              remove: fs.remove(socketPath, { recursive: true, force: true }).pipe(
                Effect.mapError((cause) => errorFor("remove", cause)),
                Effect.tap(() => Ref.set(endpoint, undefined)),
              ),
            } satisfies RuntimeSession;
          }
          const image = yield* resolveArtifact({
            service: "database",
            version: config.version,
          }).pipe(Effect.mapError((cause) => errorFor("launch", cause)));
          const selectedContainer = container;
          if (selectedContainer === undefined)
            return yield* errorFor("launch", "Container runtime is unavailable");
          yield* dataCommand(config.version, ["chown", "100:101", "/instance/data"]);
          const launched = yield* selectedContainer
            .launch({
              image: image.image,
              stackId: String(options.stackId),
              instanceId: options.instanceId,
              env: {
                PGDATA: "/var/lib/postgresql/data",
                POSTGRES_USER: "supabase_admin",
                POSTGRES_DB: "postgres",
                POSTGRES_PASSWORD: Redacted.value(config.databasePassword),
              },
              args: ["-p", "5432", "-c", "listen_addresses=*", ...settings],
              mounts: [{ source: dataPath, target: "/var/lib/postgresql/data", readOnly: false }],
              ports: [5432],
            })
            .pipe(
              Effect.catchTag("ContainerLaunchError", ({ failure, process }) =>
                Effect.fail(
                  new ServiceLaunchError({
                    failure: errorFor("launch", failure),
                    runtime: runtimeFromContainer(process),
                  }),
                ),
              ),
              Effect.mapError((cause) =>
                cause instanceof ServiceLaunchError ? cause : errorFor("launch", cause),
              ),
              Scope.provide(context.scope),
            );
          const port = launched.ports[5432];
          if (port === undefined)
            return yield* errorFor("launch", "Container did not publish PostgreSQL");
          const selectedEndpoint: BackendEndpoint = { kind: "tcp", host: "127.0.0.1", port };
          yield* Ref.set(endpoint, selectedEndpoint);
          yield* publishLogs(launched, logs, context.scope);
          return {
            ...runtimeFromContainer(launched),
            health: health(
              selectedEndpoint,
              config,
              reconcileContainerPassword(
                options.runtime,
                launched.id,
                config.databasePassword,
                spawner,
              ),
              {
                fs,
                instanceRoot,
                version: config.version,
                runtime: options.runtime,
              },
            ),
            remove: runtimeFromContainer(launched).remove.pipe(
              Effect.tap(() => Ref.set(endpoint, undefined)),
            ),
          } satisfies RuntimeSession;
        }),
    );

    const definition: ServiceDefinition<DatabaseConfig> = {
      prepare,
      launch,
      removeData: (context) =>
        removeOwnedRoot(
          fs,
          path,
          instanceRoot,
          String(options.stackId),
          options.instanceId,
          Effect.gen(function* () {
            if (container === undefined || !(yield* fs.exists(path.join(instanceRoot, "data"))))
              return;
            const artifact = yield* resolveArtifact({
              service: "database",
              version: postgresVersion(context.config.version),
            });
            yield* container.prepare(artifact.image);
            yield* dataCommand(context.config.version, ["rm", "-rf", "/instance/data"]);
          }).pipe(Effect.mapError((cause) => errorFor("destroy", cause))),
        ),
    };
    return {
      definition,
      endpoint: Ref.get(endpoint).pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.fail(databaseError("endpoint", "Database is not running"))
            : Effect.succeed(value),
        ),
      ),
      logs: Stream.fromPubSub(logs),
    } satisfies DatabaseComponent;
  });

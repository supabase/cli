import { withAttemptCount } from "../internal/attempts.ts";
import { PgClient } from "@effect/sql-pg";
import {
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  Fiber,
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
  slimImageMirrors,
  prepareNativeArtifact,
  postgresVersion,
  resolveArtifact,
  useNativeArtifact,
  type PreparedNativeArtifact,
} from "../Artifacts.ts";
import {
  makeContainerRuntime,
  type ContainerProcess,
  type ContainerRuntime,
  type EngineTarget,
  type HostGateway,
} from "../runtime/Container.ts";
import { DatabaseBootstrapError, runDatabaseBootstrap } from "../runtime/DatabaseBootstrap.ts";
import {
  ensureInternalDatabase,
  makeDatabaseSessionFromSqlClient,
} from "../runtime/PostgresDatabaseSession.ts";
import {
  mapToServiceError,
  processExit as sharedProcessExit,
  publishProcessLogs,
  runtimeSessionFromContainer,
} from "../runtime/Session.ts";
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
import {
  acquireNativeRuntimeRoot,
  handOverNativePostgresFiles,
  openNativePostgresInstance,
  resolveNativePostgresUser,
  type PasswdEntry,
} from "../runtime/postgres-user.ts";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import type * as Claims from "../namespace/Claims.ts";
import * as Environment from "../namespace/Environment.ts";
import { containerInstancePath, destroyOwnedRoot } from "../namespace/Paths.ts";
import { DEFAULT_POSTGRES_ROOT_KEY } from "../Defaults.ts";
import {
  instanceSnapshotsDirectory,
  makeDatabaseSnapshots,
  type SnapshotScope,
} from "./DatabaseSnapshot.ts";
import type { DockerHelperRegistry } from "../storage/DockerHelperRegistry.ts";
import {
  makeDockerDatabaseStorage,
  type DockerDatabaseStorage,
  type DockerDatabaseStorageError,
} from "../storage/DockerDatabaseStorage.ts";

export const DatabaseConfig = Schema.Struct({
  version: Schema.String,
  databasePassword: Schema.Redacted(Schema.String),
  jwtSecret: Schema.Redacted(Schema.String),
  jwtExpiry: Schema.Finite,
  healthTimeoutMs: Schema.optionalKey(Schema.Finite),
  /** When 0, the database is disposable and can use reduced-durability settings. */
  stopGraceSeconds: Schema.optionalKey(Schema.Finite),
  rootKey: Schema.optionalKey(Schema.Redacted(Schema.String)),
  settings: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  ),
});

const DatabaseReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker"]),
  profile: Schema.Literal("supabase"),
});

// Health reconciles role passwords as supabase_admin, including after a configured password change.
const NATIVE_HBA_RULES = "local all supabase_admin trust\nlocal all all scram-sha-256\n";

export interface DatabaseConfig extends Schema.Schema.Type<typeof DatabaseConfig> {}

export const DatabaseEndpoints = Schema.Struct({ sql: Schema.optionalKey(EndpointIntent) });
export interface DatabaseEndpoints extends Schema.Schema.Type<typeof DatabaseEndpoints> {}
export const DatabaseCreation = serviceCreation("database", DatabaseConfig, DatabaseEndpoints);
export interface DatabaseCreation extends Schema.Schema.Type<typeof DatabaseCreation> {}

export type DatabaseRuntime = "native" | "docker";

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
  /** Project folder name; the container runtime sanitizes it into names and grouping labels. */
  readonly project?: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: DatabaseRuntime;
  /** Reuses one volume helper across databases in this host. */
  readonly helpers?: DockerHelperRegistry;
  /** Shares one host-gateway probe across this host's container runtimes. */
  readonly hostGateway?: HostGateway;
  /** The engine endpoint and identity the owner resolved once at startup; absent when native. */
  readonly engineTarget?: EngineTarget;
  /** Journals the native socket directory this database creates under `/tmp`, outside its data root. */
  readonly directoryClaims: Claims.DirectoryClaims;
}

export interface DatabaseComponent {
  readonly definition: ServiceDefinition<DatabaseConfig>;
  readonly resetData: (
    context: ServiceInstanceContext<DatabaseConfig>,
  ) => Effect.Effect<void, ServiceError>;
  readonly saveSnapshot: (
    context: ServiceInstanceContext<DatabaseConfig>,
    key: string,
    scope: SnapshotScope,
  ) => Effect.Effect<void, ServiceError>;
  readonly restoreSnapshot: (
    context: ServiceInstanceContext<DatabaseConfig>,
    key: string,
    scope: SnapshotScope,
  ) => Effect.Effect<boolean, ServiceError>;
  readonly endpoint: Effect.Effect<BackendEndpoint, DatabaseError>;
  readonly logs: Stream.Stream<DatabaseLog, DatabaseError>;
}

const errorFor = mapToServiceError;

const postgresArguments = (config: DatabaseConfig): Array<string> => {
  const configured = new Set(Object.keys(config.settings ?? {}).map((key) => key.toLowerCase()));
  const settings = Object.entries(config.settings ?? {}).flatMap(([key, value]) => [
    "-c",
    `${key}=${String(value)}`,
  ]);
  // Shadow databases are discarded, so they can use reduced-durability settings.
  if (config.stopGraceSeconds === 0)
    for (const setting of ["fsync=off", "synchronous_commit=off", "full_page_writes=off"])
      if (!configured.has(setting.slice(0, setting.indexOf("=")))) settings.push("-c", setting);
  return settings;
};

const databaseError = (operation: string, cause: unknown): DatabaseError =>
  new DatabaseError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const describePostgresExit = (code: number) => `PostgreSQL exited with code ${code}`;

/** Settles a native PostgreSQL exit, waiting briefly after it for the stderr tail to drain. */
export const processExit = <E extends { readonly message: string }>(
  exitCode: Effect.Effect<number, E>,
  stderr?: {
    readonly tail: Ref.Ref<string>;
    readonly drained: Fiber.Fiber<void>;
  },
): Effect.Effect<Exit.Exit<void, ServiceError>> =>
  sharedProcessExit(exitCode, describePostgresExit, stderr);

/** Exported for the cross-cutting pin test in {@link "../runtime/Container.integration.test.ts"}. */
export const reconcileContainerPassword = Effect.fn("Database.reconcileContainerPassword")(
  function* (
    target: EngineTarget,
    id: string,
    password: Redacted.Redacted<string>,
    spawner: ChildProcessSpawnerService["Service"],
  ) {
    const args = [
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
    ];
    yield* Effect.annotateCurrentSpan({
      "process.executable.name": target.engine,
      "process.arg_count": args.length,
    });
    // Each retry overwrites `process.exit_code`, so the span reports the last attempt's status.
    return yield* withAttemptCount(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(target.engine, [...target.argv, ...args], { stdin: "pipe" }),
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
          yield* Effect.annotateCurrentSpan("process.exit_code", Number(code));
          if (Number(code) !== 0)
            return yield* errorFor("health", "Local database credential setup has not succeeded");
        }),
      ),
      (counted) =>
        counted.pipe(
          Effect.mapError(() => errorFor("health", "Local database credential setup failed")),
          Effect.retry(Schedule.spaced("250 millis")),
        ),
      { traced: true },
    );
  },
);

/** Idempotent readiness reconciliation, so a session also re-runs it as its probe. */
const health = Effect.fn("Database.health")(function* (
  endpoint: BackendEndpoint,
  config: DatabaseConfig,
  reconcile: Effect.Effect<void, ServiceError>,
  context: {
    readonly fs: FileSystem.FileSystem;
    readonly instanceRoot: string;
    readonly version: string;
    readonly runtime: DatabaseRuntime;
    readonly markInitialized?: Effect.Effect<void, ServiceError>;
  },
) {
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
  const retryProbe = withAttemptCount(probe, (counted) =>
    counted.pipe(Effect.retry(Schedule.spaced("250 millis"))),
  );
  return yield* reconcile.pipe(
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
          if (context.markInitialized !== undefined) yield* context.markInitialized;
          yield* context.fs.rename(
            `${stage}/marker`,
            `${context.instanceRoot}/.supabase-database-ready.json`,
          );
        }),
      ),
    ),
    Effect.timeoutOrElse({
      duration: config.healthTimeoutMs ?? 60_000,
      orElse: () => Effect.fail(errorFor("health", "Database readiness timed out")),
    }),
    Effect.mapError((cause) => errorFor("health", cause)),
  );
});

const publishLogs = publishProcessLogs;

const runtimeFromContainer = (process: ContainerProcess, discard: boolean): RuntimeSession =>
  runtimeSessionFromContainer(process, describePostgresExit, { discard });

const nativeProcess = (
  artifact: PreparedNativeArtifact,
  config: DatabaseConfig,
  paths: {
    readonly dataPath: string;
    readonly socketPath: string;
    readonly hbaPath: string;
    readonly rootKeyPath: string;
  },
  settings: ReadonlyArray<string>,
  scope: Scope.Closeable,
  stackId: string,
  instanceId: string,
  spawner: ChildProcessSpawnerService["Service"],
  user: PasswdEntry | undefined,
  environment: Environment.NativeEnvironment,
): Effect.Effect<NativeProcess, ServiceError> =>
  spawnNativeProcess(
    {
      executable: artifact.executable,
      artifactLockPath: artifact.lockPath,
      ...(user === undefined ? {} : { uid: user.uid, gid: user.gid, cwd: "/" }),
      args: [
        "-D",
        paths.dataPath,
        "-p",
        "5432",
        "-c",
        "listen_addresses=",
        "-c",
        `unix_socket_directories=${paths.socketPath}`,
        "-c",
        `hba_file=${paths.hbaPath}`,
        ...settings,
      ],
      env: {
        PGDATA: paths.dataPath,
        PGSODIUM_KEY_FILE: paths.rootKeyPath,
        POSTGRES_USER: "supabase_admin",
        POSTGRES_DB: "postgres",
        POSTGRES_PASSWORD: Redacted.value(config.databasePassword),
      },
      environment,
      gracefulStopSignal: "SIGINT",
      gracefulStopTimeout: "15 seconds",
    },
    defaultNativeProcessLauncher(),
    { stackId, workloadId: instanceId },
  ).pipe(
    Scope.provide(scope),
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(String(options.stackId)))
      return yield* databaseError("identity", "Invalid stack id");
    // Ownership is by location: instanceRoot is owned simply by being under options.root, with no
    // separate marker to establish or verify. Still created eagerly here, since the storage
    // marker write below assumes the directory exists rather than creating it itself.
    const instanceRoot = path.join(options.root, options.instanceId);
    yield* fs
      .makeDirectory(instanceRoot, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => databaseError("root", cause)));
    const container: ContainerRuntime | undefined =
      options.engineTarget === undefined
        ? undefined
        : yield* makeContainerRuntime({
            target: options.engineTarget,
            root: options.root,
            imageMirrors: slimImageMirrors,
            ...(options.hostGateway === undefined ? {} : { hostGateway: options.hostGateway }),
            // PostgreSQL's outbound HTTP falls back across address families.
            awaitHostGateway: false,
          });
    const storage: DockerDatabaseStorage | undefined =
      options.engineTarget === undefined
        ? undefined
        : yield* makeDockerDatabaseStorage({
            runtime: options.runtime,
            target: options.engineTarget,
            stackId: String(options.stackId),
            instanceId: options.instanceId,
            ...(options.project === undefined ? {} : { project: options.project }),
            instanceRoot,
            root: options.root,
            cacheRoot: options.cacheRoot,
            fs,
            path,
            crypto,
            container,
            spawner,
            ...(options.helpers === undefined ? {} : { helpers: options.helpers }),
          }).pipe(Effect.mapError((cause) => databaseError("storage", cause)));

    const snapshots = (version: string) =>
      makeDatabaseSnapshots({
        instanceRoot,
        cacheRoot: options.cacheRoot,
        runtime: options.runtime,
        version,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) => errorFor("snapshot", cause)),
      );

    const dataCommand = Effect.fn("Database.containerFiles")(
      function* (version: string, args: ReadonlyArray<string>) {
        if (container === undefined) return "";
        const artifact = yield* resolveArtifact({
          service: "database",
          version: postgresVersion(version),
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* container.launchCommand({
              image: artifact.image,
              stackId: String(options.stackId),
              instanceId: options.instanceId,
              service: "database",
              project: options.project,
              entrypoint: "/usr/bin/busybox",
              args,
              env: {},
              mounts: [
                storage === undefined
                  ? { source: instanceRoot, target: containerInstancePath, readOnly: false }
                  : yield* storage.mount(version).pipe(
                      Effect.map((mount) => ({ ...mount, target: "/var/lib/postgresql/data" })),
                      Effect.mapError((cause) => errorFor("data", cause)),
                    ),
              ],
            });
            return yield* Effect.acquireUseRelease(
              Effect.succeed(child),
              (child) =>
                Effect.gen(function* () {
                  const [, stdout, stderr, code] = yield* Effect.all(
                    [
                      Stream.empty.pipe(Stream.run(child.stdin)),
                      child.stdout.pipe(
                        Stream.decodeText,
                        Stream.runFold(
                          () => "",
                          (text, chunk) => (text + chunk).slice(-65536),
                        ),
                      ),
                      child.stderr.pipe(
                        Stream.decodeText,
                        Stream.runFold(
                          () => "",
                          (text, chunk) => (text + chunk).slice(-4096),
                        ),
                      ),
                      child.exitCode,
                    ],
                    { concurrency: "unbounded" },
                  );
                  if (code !== 0)
                    return yield* errorFor(
                      "data",
                      stderr.trim() || "Container filesystem operation failed",
                    );
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
        // Ahead-of-time warm-up only: downloads and publishes the generation but pins nothing.
        // `launch` resolves (or prepares) and pins its own copy right before it spawns.
        return prepareNativeArtifact({ service: "database", version }, options.cacheRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, client),
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
      },
      Effect.mapError((cause) => errorFor("prepare", cause)),
    );

    const openDatabaseContainer = Effect.fn("Database.openContainer")(function* (
      context: ServiceInstanceContext<DatabaseConfig>,
    ) {
      const config = {
        ...context.config,
        version: postgresVersion(context.config.version),
        rootKey: context.config.rootKey ?? Redacted.make(DEFAULT_POSTGRES_ROOT_KEY),
      };
      const dataPath = path.join(instanceRoot, "data");
      const dataMount =
        storage === undefined
          ? yield* fs.makeDirectory(dataPath, { recursive: true, mode: 0o700 }).pipe(
              Effect.mapError((cause) => errorFor("launch", cause)),
              Effect.as({
                source: dataPath,
                target: "/var/lib/postgresql/data",
                readOnly: false,
              }),
            )
          : yield* storage
              .mount(config.version)
              .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
      const rootKeyPath = path.join(instanceRoot, "pgsodium_root.key");
      yield* fs
        .writeFileString(rootKeyPath, Redacted.value(config.rootKey), {
          mode: options.runtime === "native" ? 0o600 : 0o644,
        })
        .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
      const settings = postgresArguments(config);
      const selectedContainer = container;
      if (selectedContainer === undefined)
        return yield* errorFor("launch", "Container runtime is unavailable");
      const image = yield* resolveArtifact({
        service: "database",
        version: config.version,
      }).pipe(Effect.mapError((cause) => errorFor("launch", cause)));
      if (
        storage === undefined ||
        (yield* storage.needsDataChown.pipe(Effect.mapError((cause) => errorFor("launch", cause))))
      ) {
        yield* dataCommand(config.version, ["chown", "100:101", "/var/lib/postgresql/data"]);
      }
      const launched = selectedContainer
        .launch({
          image: image.image,
          stackId: String(options.stackId),
          instanceId: options.instanceId,
          service: "database",
          project: options.project,
          env: {
            PGDATA: "/var/lib/postgresql/data",
            PGSODIUM_KEY_FILE: "/etc/postgresql-custom/pgsodium_root.key",
            POSTGRES_USER: "supabase_admin",
            POSTGRES_DB: "postgres",
            POSTGRES_PASSWORD: Redacted.value(config.databasePassword),
          },
          args: ["-p", "5432", "-c", "listen_addresses=*", ...settings],
          mounts: [
            dataMount,
            {
              source: rootKeyPath,
              target: "/etc/postgresql-custom/pgsodium_root.key",
              readOnly: true,
            },
          ],
          ports: [5432],
          // SIGTERM is PostgreSQL's smart shutdown, which waits for every client to disconnect.
          stopSignal: "SIGINT",
          ...(config.stopGraceSeconds === undefined
            ? {}
            : { stopGraceSeconds: config.stopGraceSeconds }),
        })
        .pipe(
          Effect.catchTag("ContainerLaunchError", ({ failure, process }) =>
            Effect.fail(
              new ServiceLaunchError({
                failure: errorFor("launch", failure),
                runtime: runtimeFromContainer(process, false),
              }),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof ServiceLaunchError ? cause : errorFor("launch", cause),
          ),
        );
      return yield* launched.pipe(Scope.provide(context.scope));
    });

    const launch = Effect.fn("Database.launch")(
      (
        context: ServiceInstanceContext<DatabaseConfig>,
      ): Effect.Effect<RuntimeSession, ServiceError | ServiceLaunchError> =>
        Effect.gen(function* () {
          const postgresUser = yield* resolveNativePostgresUser(options.runtime).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          if (postgresUser._tag === "Unavailable")
            return yield* errorFor("launch", `${postgresUser.message}. ${postgresUser.suggestion}`);
          const stepDownUser = postgresUser._tag === "StepDown" ? postgresUser.user : undefined;
          const asRoot = <A, E>(
            effect: Effect.Effect<
              A,
              E,
              FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
            >,
          ) =>
            effect.pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError((cause) => errorFor("launch", cause)),
            );
          const config = {
            ...context.config,
            version: postgresVersion(context.config.version),
            rootKey: context.config.rootKey ?? Redacted.make(DEFAULT_POSTGRES_ROOT_KEY),
          };
          if (storage !== undefined)
            yield* storage
              .prepare(config.version)
              .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
          const settings = postgresArguments(config);
          if (options.runtime === "native") {
            if (postgresUser._tag === "StepDown") yield* Effect.logInfo(postgresUser.message);
            const nativeRoot =
              stepDownUser === undefined
                ? instanceRoot
                : yield* asRoot(openNativePostgresInstance(stepDownUser, instanceRoot));
            // A dedicated subdirectory, never the owned root itself, so a step-down chown of it
            // never touches `nativeRoot`'s own root-only ownership that the next launch verifies.
            const environment = yield* Environment.confine(
              fs,
              path,
              path.join(nativeRoot, "home"),
            ).pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            const dataPath = path.join(nativeRoot, "data");
            yield* fs
              .makeDirectory(dataPath, { recursive: true, mode: 0o700 })
              .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            const rootKeyPath = path.join(nativeRoot, "pgsodium_root.key");
            yield* fs
              .writeFileString(rootKeyPath, Redacted.value(config.rootKey), { mode: 0o600 })
              .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            // PostgreSQL limits Unix socket paths to 103 bytes, so this directory nests under the
            // short per-uid native runtime root (acquired and validated below) rather than under
            // instanceRoot. Ownership by location there keeps a foreign uid from ever creating or
            // replacing it, and keeps recovery from ever having to delete outside it.
            // The pathname is picked and journaled before the directory exists, so a SIGKILL
            // between the claim and the create always leaves reconcile a recoverable claim.
            // An existing path is never ours, so a failed exclusive create drops the claim.
            const runtimeRoot = yield* asRoot(acquireNativeRuntimeRoot());
            const socketSuffix = yield* crypto.randomUUIDv4.pipe(
              Effect.map((uuid) => uuid.replaceAll("-", "")),
              Effect.mapError((cause) => errorFor("launch", cause)),
            );
            const socketPath = path.join(runtimeRoot, `pg-${socketSuffix}`);
            yield* Effect.acquireRelease(
              options.directoryClaims
                .claim(socketPath)
                .pipe(
                  Effect.andThen(
                    fs
                      .makeDirectory(socketPath, { mode: 0o700 })
                      .pipe(Effect.tapError(() => options.directoryClaims.unclaim(socketPath))),
                  ),
                ),
              () =>
                fs.remove(socketPath, { recursive: true, force: true }).pipe(
                  Effect.andThen(options.directoryClaims.unclaim(socketPath)),
                  Effect.catch((cause) => Effect.logError(cause)),
                ),
            ).pipe(
              Scope.provide(context.scope),
              Effect.mapError((cause) => errorFor("launch", cause)),
            );
            const hbaPath = path.join(socketPath, "pg_hba.conf");
            yield* fs
              .writeFileString(hbaPath, NATIVE_HBA_RULES, { mode: 0o600 })
              .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            // `context.scope` finalizes its direct children in parallel (it is forked "parallel"
            // in Service.ts), so registering the pin there directly would race its release
            // against the native process's own cleanup. A "sequential" child scope finalizes
            // LIFO instead: the pin is registered on it first, and the native process below is
            // also scoped to it (not to `context.scope`), so closing it always runs the
            // process's cleanup before releasing the pin.
            const launchScope = yield* Scope.fork(context.scope, "sequential");
            const artifact = yield* useNativeArtifact(
              { service: "database", version: config.version },
              options.cacheRoot,
            ).pipe(
              Scope.provide(launchScope),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(HttpClient.HttpClient, client),
              Effect.mapError((cause) => errorFor("launch", cause)),
            );
            if (stepDownUser !== undefined)
              yield* asRoot(
                handOverNativePostgresFiles(stepDownUser, {
                  dataPath,
                  rootKeyPath,
                  socketPath,
                  hbaPath,
                  runtimeRoot,
                  bundleRoot: artifact.root,
                  executable: artifact.executable,
                  environmentHome: environment.values.HOME,
                }),
              );
            const process = yield* nativeProcess(
              artifact,
              config,
              { dataPath, socketPath, hbaPath, rootKeyPath },
              settings,
              launchScope,
              String(options.stackId),
              options.instanceId,
              spawner,
              stepDownUser,
              environment,
            );
            const selectedEndpoint: BackendEndpoint = {
              kind: "unix",
              path: socketPath,
              port: 5432,
            };
            yield* Ref.set(endpoint, selectedEndpoint);
            const stderrTail = yield* Ref.make("");
            const stderrDrained = yield* publishLogs(process, logs, context.scope, stderrTail);
            const setup = health(selectedEndpoint, config, Effect.void, {
              fs,
              instanceRoot,
              version: config.version,
              runtime: options.runtime,
              markInitialized:
                storage === undefined
                  ? undefined
                  : storage
                      .markInitialized(config.version)
                      .pipe(Effect.mapError((cause) => errorFor("health", cause))),
            });
            return {
              health: setup,
              probe: setup,
              exit: processExit(process.exitCode, { tail: stderrTail, drained: stderrDrained }),
              stop: process.kill.pipe(Effect.mapError((cause) => errorFor("stop", cause))),
              remove: fs.remove(socketPath, { recursive: true, force: true }).pipe(
                Effect.mapError((cause) => errorFor("remove", cause)),
                Effect.tap(() => Ref.set(endpoint, undefined)),
              ),
            } satisfies RuntimeSession;
          }
          const launched = yield* openDatabaseContainer(context);
          const port = launched.ports[5432];
          if (port === undefined)
            return yield* errorFor("launch", "Container did not publish PostgreSQL");
          const selectedEndpoint: BackendEndpoint = { kind: "tcp", host: "127.0.0.1", port };
          yield* Ref.set(endpoint, selectedEndpoint);
          yield* publishLogs(launched, logs, context.scope);
          const session = runtimeFromContainer(launched, config.stopGraceSeconds === 0);
          const engineTarget = options.engineTarget;
          if (engineTarget === undefined)
            return yield* errorFor("launch", "Container runtime is unavailable");
          const setup = health(
            selectedEndpoint,
            config,
            reconcileContainerPassword(engineTarget, launched.id, config.databasePassword, spawner),
            {
              fs,
              instanceRoot,
              version: config.version,
              runtime: options.runtime,
              markInitialized:
                storage === undefined
                  ? undefined
                  : storage
                      .markInitialized(config.version)
                      .pipe(Effect.mapError((cause) => errorFor("health", cause))),
            },
          );
          return {
            ...session,
            health: setup,
            probe: setup,
            remove: session.remove.pipe(Effect.tap(() => Ref.set(endpoint, undefined))),
          } satisfies RuntimeSession;
        }),
    );

    const definition: ServiceDefinition<DatabaseConfig> = {
      prepare,
      launch,
      removeData: (context) =>
        destroyOwnedRoot(
          fs,
          path,
          instanceRoot,
          options.root,
          storage === undefined
            ? Effect.void
            : storage
                .destroyData(postgresVersion(context.config.version))
                .pipe(Effect.mapError((cause) => errorFor("destroy", cause))),
          errorFor,
        ),
    };
    const resetData = Effect.fn("Database.resetData")((
      context: ServiceInstanceContext<DatabaseConfig>,
    ) => {
      const clear: Effect.Effect<void, ServiceError | DockerDatabaseStorageError> =
        storage === undefined
          ? destroyOwnedRoot(fs, path, instanceRoot, options.root, Effect.void, errorFor, [
              instanceSnapshotsDirectory,
            ])
          : storage.removeData(postgresVersion(context.config.version));
      return clear.pipe(Effect.mapError((cause) => errorFor("reset", cause)));
    });
    return {
      definition,
      resetData,
      saveSnapshot: (context, key, scope) =>
        storage === undefined
          ? Effect.flatMap(snapshots(context.config.version), (store) =>
              store.saveSnapshot(key, scope),
            ).pipe(Effect.mapError((cause) => errorFor("snapshot", cause)))
          : storage
              .saveSnapshot(postgresVersion(context.config.version), key, scope)
              .pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
      restoreSnapshot: (context, key, scope) =>
        storage === undefined
          ? Effect.flatMap(snapshots(context.config.version), (store) =>
              store.restoreSnapshot(key, scope),
            ).pipe(Effect.mapError((cause) => errorFor("snapshot", cause)))
          : storage
              .restoreSnapshot(postgresVersion(context.config.version), key, scope)
              .pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
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

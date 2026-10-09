import { withAttemptCount } from "../internal/attempts.ts";
import { PgClient } from "@effect/sql-pg";
import {
  Config,
  Context,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
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
  processExit,
  publishProcessLogs,
  runtimeSessionFromContainer,
  launchOutputPublisher,
  type LaunchOutput,
} from "../runtime/Session.ts";
import {
  ServiceError,
  ServiceLaunchError,
  type RuntimeSession,
  type ServiceDefinition,
  type ServiceInstanceContext,
  type ServiceLaunchContext,
} from "../Service.ts";
import {
  defaultNativeProcessLauncher,
  spawnNativeProcess,
  type NativeProcess,
  type NativeProcessIdentity,
  type NativeProcessSpec,
} from "../runtime/NativeProcess.ts";
import type { StackId } from "../identity/StackId.ts";
import {
  acquireNativeRuntimeRoot,
  nativeSocketDirectoryPath,
  removeNativeSocketDirectory,
  handOverNativePostgresFiles,
  openNativePostgresInstance,
  resolveNativePostgresUser,
  type PasswdEntry,
} from "../runtime/postgres-user.ts";
import { EndpointIntent, serviceCreation, type CatalogLogs } from "./Recipe.ts";
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
  /** When 0, the database is disposable: reduced durability and pg_cron's default mode. */
  stopGraceSeconds: Schema.optionalKey(Schema.Finite),
  rootKey: Schema.optionalKey(Schema.Redacted(Schema.String)),
  settings: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  ),
});

const DatabaseReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  profile: Schema.Literal("supabase"),
});

// Health reconciles role passwords as supabase_admin, including after a configured password change.
const NATIVE_HBA_RULES = "local all supabase_admin trust\nlocal all all scram-sha-256\n";

export interface DatabaseConfig extends Schema.Schema.Type<typeof DatabaseConfig> {}

export const DatabaseEndpoints = Schema.Struct({ sql: Schema.optionalKey(EndpointIntent) });
export interface DatabaseEndpoints extends Schema.Schema.Type<typeof DatabaseEndpoints> {}
export const DatabaseCreation = serviceCreation("database", DatabaseConfig, DatabaseEndpoints);
export interface DatabaseCreation extends Schema.Schema.Type<typeof DatabaseCreation> {}

export type DatabaseRuntime = "native" | "docker" | "podman";

export type BackendEndpoint =
  | { readonly kind: "unix"; readonly path: string; readonly port: 5432 }
  | { readonly kind: "tcp"; readonly host: "127.0.0.1"; readonly port: number };

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
  readonly logs: CatalogLogs;
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
          idleTimeout: "10 seconds",
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
              idleTimeout: "10 seconds",
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
                idleTimeout: "10 seconds",
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
      orElse: () =>
        Effect.fail(errorFor("health", "Database readiness timed out", "health-timeout")),
    }),
    Effect.mapError((cause) => errorFor("health", cause)),
  );
});

const publishLogs = publishProcessLogs;

const runtimeFromContainer = (process: ContainerProcess, discard: boolean): RuntimeSession =>
  runtimeSessionFromContainer(process, describePostgresExit, { discard });

const hostCaBundles = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/**
 * Forwards the host's SSL_CERT_FILE and SSL_CERT_DIR, defaulting SSL_CERT_FILE to its first CA
 * bundle present, because the bundled OpenSSL behind http and pg_net defaults to a trust store under
 * /nix on macOS. Exported values are resolved here because PostgreSQL runs from its data directory.
 */
const nativeTrustStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env: Record<string, string> = {};
  for (const name of ["SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = yield* Config.option(Config.NonEmptyString(name)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    // OpenSSL splits SSL_CERT_DIR on ":" on macOS and Linux, the native targets, and skips blanks.
    if (Option.isSome(value))
      env[name] =
        name === "SSL_CERT_DIR"
          ? value.value
              .split(":")
              .map((entry) => (entry === "" ? entry : path.resolve(entry)))
              .join(":")
          : path.resolve(value.value);
  }
  if (env.SSL_CERT_FILE !== undefined) return env;
  for (const bundle of hostCaBundles)
    if (yield* fs.exists(bundle).pipe(Effect.orElseSucceed(() => false)))
      return { ...env, SSL_CERT_FILE: bundle };
  return env;
});

/* Background workers skip session_preload_libraries, so supautils must be shared-preloaded. */
const sharedPreload = Effect.fn("Database.sharedPreload")(function* (
  artifact: PreparedNativeArtifact,
  spec: NativeProcessSpec & { readonly args: ReadonlyArray<string> },
  dataPath: string,
  settings: ReadonlyArray<string>,
  identity: NativeProcessIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const probe = yield* spawnNativeProcess(
    {
      ...spec,
      executable: `${artifact.root}/bin/postgres`,
      args: [
        ...((yield* fs.exists(`${dataPath}/PG_VERSION`))
          ? spec.args
          : [
              "-D",
              dataPath,
              "-c",
              `config_file=${artifact.root}/share/supabase-cli/config/postgresql.conf.template`,
              ...settings,
            ]),
        "-C",
        "shared_preload_libraries",
      ],
    },
    defaultNativeProcessLauncher(),
    identity,
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      probe.stdout.pipe(Stream.decodeText, Stream.mkString),
      probe.stderr.pipe(
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (text, chunk) => (text + chunk).slice(-4096),
        ),
      ),
      probe.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  yield* Effect.annotateCurrentSpan("process.exit_code", Number(code));
  if (code !== 0)
    return yield* errorFor(
      "exit",
      `${describePostgresExit(Number(code))}: ${stderr.trim() || stdout.trim() || "PostgreSQL configuration probe failed"}`,
    );
  const libraries = [stdout.trim(), "supautils"].filter((library) => library !== "").join(",");
  return ["-c", `shared_preload_libraries=${libraries}`];
}, Effect.scoped);

const nativeProcess = (
  artifact: PreparedNativeArtifact,
  config: DatabaseConfig,
  paths: {
    readonly dataPath: string;
    readonly socketPath: string;
    readonly hbaPath: string;
    readonly rootKeyPath: string;
    readonly configPath: string | undefined;
  },
  settings: ReadonlyArray<string>,
  scope: Scope.Closeable,
  stackId: string,
  instanceId: string,
  spawner: ChildProcessSpawnerService["Service"],
  user: PasswdEntry | undefined,
  environment: Environment.NativeEnvironment,
  trustStore: Readonly<Record<string, string>>,
  fs: FileSystem.FileSystem,
): Effect.Effect<NativeProcess, ServiceError> => {
  const identity = { stackId, workloadId: instanceId };
  const spec = {
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
      ...(paths.configPath === undefined
        ? []
        : ["-c", "cron.use_background_workers=on", "-c", `config_file=${paths.configPath}`]),
      ...settings,
    ],
    env: {
      ...trustStore,
      PGDATA: paths.dataPath,
      PGSODIUM_KEY_FILE: paths.rootKeyPath,
      POSTGRES_USER: "supabase_admin",
      POSTGRES_DB: "postgres",
      POSTGRES_PASSWORD: Redacted.value(config.databasePassword),
    },
    environment,
    gracefulStopSignal: "SIGINT",
    gracefulStopTimeout: "15 seconds",
  } satisfies NativeProcessSpec;
  return Effect.gen(function* () {
    const preload =
      paths.configPath === undefined
        ? []
        : yield* sharedPreload(artifact, spec, paths.dataPath, settings, identity).pipe(
            Effect.timeoutOrElse({
              duration: config.healthTimeoutMs ?? 60_000,
              orElse: () =>
                Effect.fail(
                  errorFor("launch", "PostgreSQL configuration probe timed out", "timeout"),
                ),
            }),
          );
    return yield* spawnNativeProcess(
      { ...spec, args: [...spec.args, ...preload] },
      defaultNativeProcessLauncher(),
      identity,
    );
  }).pipe(
    Scope.provide(scope),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.mapError((cause) => errorFor("launch", cause)),
  );
};

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
    const logs = yield* PubSub.sliding<LaunchOutput>(256);
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
        context: ServiceLaunchContext<DatabaseConfig>,
      ): Effect.Effect<RuntimeSession, ServiceError | ServiceLaunchError> =>
        Effect.gen(function* () {
          const publish = yield* (yield* launchOutputPublisher(logs, context.launchId)).part;
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
            // replacing it, and its derived name lets recovery find a leftover without a journal.
            const runtimeRoot = yield* asRoot(acquireNativeRuntimeRoot());
            const socketPath = yield* nativeSocketDirectoryPath(
              crypto,
              path,
              runtimeRoot,
              options.root,
              options.instanceId,
            ).pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            // A directory already at the derived name is a previous run's leftover.
            yield* Effect.acquireRelease(
              fs
                .remove(socketPath, { recursive: true, force: true })
                .pipe(Effect.andThen(fs.makeDirectory(socketPath, { mode: 0o700 }))),
              () =>
                fs
                  .remove(socketPath, { recursive: true, force: true })
                  .pipe(Effect.catch((cause) => Effect.logError(cause))),
            ).pipe(
              Scope.provide(context.scope),
              Effect.mapError((cause) => errorFor("launch", cause)),
            );
            const hbaPath = path.join(socketPath, "pg_hba.conf");
            yield* fs
              .writeFileString(hbaPath, NATIVE_HBA_RULES, { mode: 0o600 })
              .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            /* pg_cron's default TCP jobs can't reach this socket-only server; shadows keep that mode. */
            const configPath =
              config.stopGraceSeconds === 0 ? undefined : path.join(socketPath, "postgresql.conf");
            if (configPath !== undefined) {
              const original = path
                .resolve(dataPath, "postgresql.conf")
                .replaceAll("\\", "\\\\")
                .replaceAll("'", "''");
              /* A wrapper default stays beneath postgresql.conf, ALTER SYSTEM, and caller settings. */
              yield* fs
                .writeFileString(
                  configPath,
                  `max_worker_processes = 17\ninclude = '${original}'\n`,
                  { mode: 0o600 },
                )
                .pipe(Effect.mapError((cause) => errorFor("launch", cause)));
            }
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
              { dataPath, socketPath, hbaPath, rootKeyPath, configPath },
              settings,
              launchScope,
              String(options.stackId),
              options.instanceId,
              spawner,
              stepDownUser,
              environment,
              yield* nativeTrustStore.pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              ),
              fs,
            );
            const selectedEndpoint: BackendEndpoint = {
              kind: "unix",
              path: socketPath,
              port: 5432,
            };
            yield* Ref.set(endpoint, selectedEndpoint);
            const stderrTail = yield* Ref.make("");
            const stderrDrained = yield* publishLogs(process, publish, context.scope, stderrTail);
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
              exit: processExit(process.exitCode, describePostgresExit, {
                tail: stderrTail,
                drained: stderrDrained,
              }),
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
          yield* publishLogs(launched, publish, context.scope);
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

    // Removed before the registration that lets recovery recompute its name, so a failure here
    // leaves the instance registered to retry.
    const removeSocketDirectory =
      options.runtime === "native"
        ? removeNativeSocketDirectory(options.root, options.instanceId).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) => errorFor("destroy", cause)),
          )
        : Effect.void;

    const definition: ServiceDefinition<DatabaseConfig> = {
      prepare,
      launch,
      removeData: (context) =>
        destroyOwnedRoot(
          fs,
          path,
          instanceRoot,
          options.root,
          removeSocketDirectory.pipe(
            Effect.andThen(
              storage === undefined
                ? Effect.void
                : storage
                    .destroyData(postgresVersion(context.config.version))
                    .pipe(Effect.mapError((cause) => errorFor("destroy", cause))),
            ),
          ),
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
      logs: PubSub.subscribe(logs),
    } satisfies DatabaseComponent;
  });

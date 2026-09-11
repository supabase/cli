import { PgClient } from "@effect/sql-pg";
import {
  Crypto,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- loopback bind is the port allocator.
import { createServer } from "node:net";
import { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import {
  DEFAULT_DATABASE_HEALTH_TIMEOUT,
  parseGoDuration,
} from "../model/capabilities/database.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import {
  ContainerEngineError,
  EphemeralPostgresError,
  PortUnavailableError,
  StackPreparationError,
  type EphemeralPostgresCreateError,
} from "../public/Errors.ts";
import {
  resolveEphemeralPostgresRelease,
  type CreateEphemeralPostgresOptions,
  type EffectEphemeralPostgres,
} from "../public/EphemeralPostgres.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { defaultRuntimeEnvironment, StackRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { checkHostPort } from "../supervisor/HostListener.ts";
import { probeReadiness } from "./ReadinessProbe.ts";
import {
  defaultNativeProcessLauncher,
  spawnNativeProcess,
  type NativeProcess,
} from "./NativeProcess.ts";
import { bootstrapManagedPostgres } from "./PostgresDatabaseSession.ts";
import { makeProductionRuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import { resolveContainerEngine, ContainerEngineResolver } from "./ContainerEngineResolver.ts";
import type { ContainerEngine } from "./ContainerEngine.ts";
import { encodeRuntimeEnvFile } from "./RuntimeEnvFile.ts";

const DATABASE_WORKLOAD_ID = "database:database";
const PGDATA_DIR_NAME = "data";
const CONTAINER_PGDATA_PARENT = "/var/lib/postgresql";
const SNAPSHOT_MOUNT = "/snapshot";
const BUSYBOX = "/usr/bin/busybox";
const RUNTIME_MARKER = ".supabase-ephemeral-runtime";
const DEFAULT_JWT_EXPIRY = 3600;

const RuntimeMarkerSchema = Schema.Struct({
  kind: Schema.Literals(["native", "container"] as const),
  engine: Schema.optionalKey(Schema.Literals(["docker", "podman"] as const)),
});
type RuntimeMarker = Schema.Schema.Type<typeof RuntimeMarkerSchema>;

const ephemeralError = (
  message: string,
  fields: Omit<ConstructorParameters<typeof EphemeralPostgresError>[0], "message"> = {},
) => new EphemeralPostgresError({ message, ...fields });

const resolvedRuntime = (preference?: CreateEphemeralPostgresOptions["runtime"]): StackRuntime =>
  preference?.kind === "container"
    ? { kind: "container", engine: preference.engine ?? "docker" }
    : { kind: "native" };

const plannedWorkload = (
  version: string,
  image: string,
  runtime: StackRuntime,
): PlannedWorkload => ({
  id: DATABASE_WORKLOAD_ID,
  capability: "database",
  bootstrap: "database",
  dependencies: [],
  readiness: { portField: "database" },
  artifacts: {
    native: { kind: "native", release: version },
    container: { kind: "container", image },
  },
  selected:
    runtime.kind === "native" ? { kind: "native", release: version } : { kind: "container", image },
});

const postgresArgs = (
  port: number,
  runtime: StackRuntime,
  settings: CreateEphemeralPostgresOptions["postgresSettings"],
): ReadonlyArray<string> => {
  const tuned = Object.entries(settings ?? {}).flatMap(([key, value]) => {
    if (value === undefined) return [];
    const rendered = String(value);
    return rendered.length === 0 ? [] : ["-c", `${key}=${rendered}`];
  });
  return [
    "-p",
    String(port),
    "-c",
    runtime.kind === "container" ? "listen_addresses=*" : "listen_addresses=127.0.0.1",
    ...tuned,
  ];
};

const postgresEnv = (input: {
  readonly port: number;
  readonly dataPath: string;
  readonly password: string;
}): Record<string, string> => ({
  SUPABASE_STACK_WORKLOAD: DATABASE_WORKLOAD_ID,
  SUPABASE_STACK_PRIVATE_PORT: String(input.port),
  PGDATA: input.dataPath,
  POSTGRES_USER: "supabase_admin",
  POSTGRES_DB: "postgres",
  POSTGRES_PASSWORD: input.password,
  TZDIR: "/var/db/timezone/zoneinfo",
});

const databaseUrl = (port: number, password: string): string =>
  `postgresql://${encodeURIComponent("postgres")}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;

const markerFor = (runtime: StackRuntime): RuntimeMarker =>
  runtime.kind === "native" ? { kind: "native" } : { kind: "container", engine: runtime.engine };

const encodeMarker = (marker: RuntimeMarker): string => JSON.stringify(marker);

const decodeMarker = (text: string): Effect.Effect<RuntimeMarker, EphemeralPostgresError> =>
  Schema.decodeEffect(Schema.fromJsonString(RuntimeMarkerSchema))(text).pipe(
    Effect.mapError(() =>
      ephemeralError("Ephemeral Postgres snapshot marker is invalid", { reason: "snapshot" }),
    ),
  );

const sameRuntime = (left: RuntimeMarker, right: StackRuntime): boolean =>
  left.kind === right.kind && (right.kind === "native" || left.engine === right.engine);

const allocateLoopbackPort = (
  requested: number | undefined,
): Effect.Effect<number, PortUnavailableError | EphemeralPostgresError> => {
  if (requested !== undefined)
    return checkHostPort("127.0.0.1", requested, "database").pipe(Effect.as(requested));
  return Effect.callback<number, EphemeralPostgresError>((resume) => {
    const server = createServer();
    let settled = false;
    const finish = (effect: Effect.Effect<number, EphemeralPostgresError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    server.once("error", (cause) =>
      finish(Effect.fail(ephemeralError("Unable to allocate a loopback port", { cause }))),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() =>
        finish(
          port > 0
            ? Effect.succeed(port)
            : Effect.fail(ephemeralError("Unable to allocate a loopback port")),
        ),
      );
    });
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // The listener never obtained a handle.
      }
    });
  });
};

const runTar = (
  args: ReadonlyArray<string>,
): Effect.Effect<void, EphemeralPostgresError, ChildProcessSpawnerService | Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("tar", args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(Effect.mapError((cause) => ephemeralError("Unable to start tar", { cause })));
      const code = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => ephemeralError("tar failed", { cause })),
      );
      if (Number(code) !== 0)
        return yield* ephemeralError(`tar failed (${String(code)})`, { reason: "snapshot" });
    }),
  );

const writeEnvFile = (
  filePath: string,
  values: Readonly<Record<string, string>>,
): Effect.Effect<string, EphemeralPostgresError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* encodeRuntimeEnvFile(values).pipe(
      Effect.mapError((cause) =>
        ephemeralError("Unable to write Postgres environment file", { cause, path: filePath }),
      ),
    );
    yield* fs
      .writeFileString(filePath, text)
      .pipe(
        Effect.mapError((cause) =>
          ephemeralError("Unable to write Postgres environment file", { cause, path: filePath }),
        ),
      );
    yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
    return filePath;
  });

const waitForPostgres = (
  port: number,
  healthTimeout: string,
): Effect.Effect<void, EphemeralPostgresError> =>
  Effect.try({
    try: () => parseGoDuration(healthTimeout),
    catch: (cause) => ephemeralError("Invalid database health timeout", { cause }),
  }).pipe(
    Effect.flatMap((deadline) =>
      probeReadiness(
        { mode: "tcp", host: "127.0.0.1", port },
        { deadline: Duration.isZero(deadline) ? Duration.seconds(1) : deadline },
      ).pipe(
        Effect.mapError((cause) =>
          ephemeralError("Ephemeral Postgres did not become ready", { cause }),
        ),
      ),
    ),
  );

const pingAdvertised = (
  port: number,
  password: string,
): Effect.Effect<void, EphemeralPostgresError, Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      yield* client.unsafe("SELECT 1");
    }).pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl(port, password)),
          connectTimeout: "2 seconds",
        }),
      ),
    ),
  ).pipe(
    Effect.mapError((cause) =>
      ephemeralError("Ephemeral Postgres did not accept a connection", { cause }),
    ),
  );

const waitForAdvertised = (
  port: number,
  password: string,
  healthTimeout: string,
): Effect.Effect<void, EphemeralPostgresError, Scope.Scope> =>
  Effect.try({
    try: () => parseGoDuration(healthTimeout),
    catch: (cause) => ephemeralError("Invalid database health timeout", { cause }),
  }).pipe(
    Effect.flatMap((deadline) =>
      Effect.timeout(
        Effect.retry(pingAdvertised(port, password), {
          schedule: Schedule.spaced("100 millis"),
        }),
        Duration.isZero(deadline) ? Duration.seconds(1) : deadline,
      ).pipe(
        Effect.mapError((cause) =>
          ephemeralError("Ephemeral Postgres did not become ready", { cause }),
        ),
      ),
    ),
  );

const bootstrap = (
  port: number,
  options: CreateEphemeralPostgresOptions,
  healthTimeout: string,
): Effect.Effect<void, EphemeralPostgresError> =>
  Effect.try({
    try: () => parseGoDuration(healthTimeout),
    catch: (cause) => ephemeralError("Invalid database health timeout", { cause }),
  }).pipe(
    Effect.flatMap((deadline) =>
      Effect.timeout(
        Effect.retry(
          bootstrapManagedPostgres({
            host: "127.0.0.1",
            port,
            databasePassword: options.databasePassword,
            jwtSecret: options.jwtSecret,
            jwtExpiry: options.jwtExpiry ?? DEFAULT_JWT_EXPIRY,
          }),
          {
            schedule: Schedule.spaced("100 millis"),
            while: (error) => error instanceof DatabaseBootstrapError && error.retryable === true,
          },
        ),
        Duration.isZero(deadline) ? Duration.seconds(1) : deadline,
      ).pipe(
        Effect.mapError((cause) =>
          ephemeralError("Ephemeral Postgres bootstrap failed", { reason: "bootstrap", cause }),
        ),
      ),
    ),
  );

interface NativeResources {
  readonly kind: "native";
  process?: NativeProcess;
  processScope?: Scope.Closeable;
}

interface ContainerResources {
  readonly kind: "container";
  readonly engine: ContainerEngine;
  networkId?: string;
  volumeId?: string;
  containerId?: string;
}

type RuntimeResources = NativeResources | ContainerResources;

interface Cluster {
  readonly identity: StackId;
  readonly root: string;
  readonly dataPath: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly version: string;
  readonly runtime: StackRuntime;
  readonly artifactIdentity: string;
  readonly executable?: string;
  readonly image?: string;
  readonly lifecycle: Semaphore.Semaphore;
  running: boolean;
  bootstrapped: boolean;
  resources: RuntimeResources;
}

const resourceName = (identity: StackId, role: string): string =>
  `supabase-eph-${identity.slice(0, 16)}-${role}`;

const createIdentity = (crypto: Crypto.Crypto): Effect.Effect<StackId, EphemeralPostgresError> =>
  Effect.gen(function* () {
    const first = yield* crypto.randomUUIDv4;
    const second = yield* crypto.randomUUIDv4;
    return yield* Schema.decodeEffect(StackIdSchema)(`${first}${second}`.replaceAll("-", ""));
  }).pipe(
    Effect.mapError((cause) => ephemeralError("Unable to allocate ephemeral identity", { cause })),
  );

const writeRuntimeMarker = (
  cluster: Cluster,
): Effect.Effect<void, EphemeralPostgresError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const markerPath = `${cluster.dataPath}/${RUNTIME_MARKER}`;
    const encoded = encodeMarker(markerFor(cluster.runtime));
    if (cluster.resources.kind === "native") {
      yield* fs.writeFileString(markerPath, encoded).pipe(
        Effect.mapError((cause) =>
          ephemeralError("Unable to write snapshot runtime marker", {
            cause,
            path: markerPath,
            reason: "snapshot",
          }),
        ),
      );
      return;
    }
    const containerId = cluster.resources.containerId;
    if (containerId === undefined)
      return yield* ephemeralError("Ephemeral Postgres container is missing", {
        reason: "snapshot",
      });
    const tempPath = `${cluster.root}/${RUNTIME_MARKER}`;
    yield* fs.writeFileString(tempPath, encoded).pipe(
      Effect.mapError((cause) =>
        ephemeralError("Unable to write snapshot runtime marker", {
          cause,
          path: tempPath,
          reason: "snapshot",
        }),
      ),
    );
    yield* cluster.resources.engine
      .copyToContainer(
        containerId,
        tempPath,
        `${CONTAINER_PGDATA_PARENT}/${PGDATA_DIR_NAME}/${RUNTIME_MARKER}`,
      )
      .pipe(
        Effect.mapError((cause) =>
          ephemeralError("Unable to copy snapshot runtime marker", { cause, reason: "snapshot" }),
        ),
      );
  });

const snapshotFileName = (
  tarPath: string,
  path: Path.Path,
): Effect.Effect<string, EphemeralPostgresError> => {
  const name = path.basename(tarPath);
  if (name.length === 0 || name === "." || name === "..")
    return Effect.fail(
      ephemeralError("Ephemeral Postgres snapshot path is invalid", {
        reason: "snapshot",
        path: tarPath,
      }),
    );
  return Effect.succeed(name);
};

/** Catalog image has no tar on PATH; busybox tar archives the volume in place. */
const runVolumeTar = (
  cluster: Cluster,
  tarPath: string,
  mode: "create" | "extract",
): Effect.Effect<void, EphemeralPostgresError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (cluster.resources.kind !== "container") return;
    const { engine, networkId, volumeId } = cluster.resources;
    if (networkId === undefined || volumeId === undefined)
      return yield* ephemeralError("Ephemeral Postgres volume is unavailable", {
        reason: "snapshot",
      });
    const image = cluster.image;
    if (image === undefined)
      return yield* ephemeralError("Ephemeral Postgres image is unavailable", {
        reason: "snapshot",
      });
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const fileName = yield* snapshotFileName(tarPath, path);
    const parent = path.dirname(tarPath);
    yield* fs.makeDirectory(parent, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        ephemeralError("Unable to create snapshot directory", {
          cause,
          path: parent,
          reason: "snapshot",
        }),
      ),
    );
    const snapshotPath = `${SNAPSHOT_MOUNT}/${fileName}`;
    const command =
      mode === "create"
        ? ["tar", "-C", CONTAINER_PGDATA_PARENT, "-cf", snapshotPath, PGDATA_DIR_NAME]
        : ["tar", "-C", CONTAINER_PGDATA_PARENT, "-xf", snapshotPath];
    yield* Effect.acquireUseRelease(
      engine
        .createContainer({
          name: resourceName(cluster.identity, "snapshot"),
          image,
          labels: {
            stackId: cluster.identity,
            ownerSessionId: cluster.identity.slice(0, 32),
            workloadId: `${DATABASE_WORKLOAD_ID}:snapshot`,
            role: "workload",
          },
          network: networkId,
          mounts: [{ source: parent, target: SNAPSHOT_MOUNT, readOnly: mode === "extract" }],
          volumeMounts: [
            {
              volume: volumeId,
              target: `${CONTAINER_PGDATA_PARENT}/${PGDATA_DIR_NAME}`,
              readOnly: false,
            },
          ],
          publications: [],
          role: "workload",
          entrypoint: BUSYBOX,
          command,
        })
        .pipe(
          Effect.mapError((cause) =>
            ephemeralError("Unable to create snapshot helper", { cause, reason: "snapshot" }),
          ),
        ),
      (created) =>
        Effect.gen(function* () {
          yield* engine.startContainer(created.id).pipe(
            Effect.mapError((cause) =>
              ephemeralError("Unable to start snapshot helper", {
                cause,
                reason: "snapshot",
              }),
            ),
          );
          const code = yield* engine.waitContainer(created.id).pipe(
            Effect.mapError((cause) =>
              ephemeralError("Snapshot helper did not finish", {
                cause,
                reason: "snapshot",
              }),
            ),
          );
          if (code !== 0)
            return yield* ephemeralError(`Snapshot helper failed (${String(code)})`, {
              reason: "snapshot",
            });
        }),
      (created) => engine.removeContainer(created.id).pipe(Effect.ignore),
    );
  });

const verifyRestoredMarker = (
  cluster: Cluster,
  restoreFrom: string,
): Effect.Effect<void, EphemeralPostgresError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const markerPath = `${cluster.dataPath}/${RUNTIME_MARKER}`;
    const exists = yield* fs.exists(markerPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists)
      return yield* ephemeralError("Ephemeral Postgres snapshot is missing a runtime marker", {
        reason: "restore-mismatch",
        path: restoreFrom,
      });
    const marker = yield* fs.readFileString(markerPath).pipe(
      Effect.mapError((cause) =>
        ephemeralError("Unable to read snapshot runtime marker", {
          cause,
          path: markerPath,
          reason: "snapshot",
        }),
      ),
      Effect.flatMap(decodeMarker),
    );
    if (!sameRuntime(marker, cluster.runtime))
      return yield* ephemeralError(
        "Ephemeral Postgres snapshot was produced by a different runtime",
        {
          reason: "restore-mismatch",
          path: restoreFrom,
        },
      );
  });

const stopNative = (cluster: Cluster): Effect.Effect<void, EphemeralPostgresError> =>
  Effect.gen(function* () {
    if (cluster.resources.kind !== "native") return;
    const process = cluster.resources.process;
    if (process !== undefined) {
      const running = yield* process.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (running)
        yield* process.kill.pipe(
          Effect.mapError((cause) =>
            ephemeralError("Unable to stop ephemeral Postgres", { cause }),
          ),
        );
    }
    const scope = cluster.resources.processScope;
    if (scope !== undefined) yield* Scope.close(scope, Exit.void);
    cluster.resources.process = undefined;
    cluster.resources.processScope = undefined;
    cluster.running = false;
  });

const stopContainer = (cluster: Cluster): Effect.Effect<void, EphemeralPostgresError> =>
  Effect.gen(function* () {
    if (cluster.resources.kind !== "container") return;
    const containerId = cluster.resources.containerId;
    if (containerId !== undefined)
      yield* cluster.resources.engine
        .stopContainer(containerId)
        .pipe(
          Effect.mapError((cause) =>
            ephemeralError("Unable to stop ephemeral Postgres", { cause }),
          ),
        );
    cluster.running = false;
  });

const startNative = (
  cluster: Cluster,
  options: CreateEphemeralPostgresOptions,
  healthTimeout: string,
  password: string,
): Effect.Effect<void, EphemeralPostgresError, ChildProcessSpawnerService | Scope.Scope> =>
  Effect.gen(function* () {
    const executable = cluster.executable;
    if (executable === undefined)
      return yield* ephemeralError("Native Postgres executable is unavailable");
    const parentScope = yield* Scope.Scope;
    const processScope = yield* Scope.fork(parentScope, "parallel");
    yield* Effect.uninterruptibleMask((restore) =>
      restore(
        spawnNativeProcess(
          {
            executable,
            args: postgresArgs(cluster.port, cluster.runtime, options.postgresSettings),
            env: postgresEnv({
              port: cluster.port,
              dataPath: cluster.dataPath,
              password,
            }),
            cwd: cluster.root,
            gracefulStopSignal: "SIGINT",
            gracefulStopTimeout: "15 seconds",
          },
          defaultNativeProcessLauncher(),
          { stackId: cluster.identity, workloadId: DATABASE_WORKLOAD_ID },
        ).pipe(Scope.provide(processScope)),
      ).pipe(
        Effect.mapError((cause) => ephemeralError("Unable to start native Postgres", { cause })),
        Effect.tap((process) =>
          Effect.sync(() => {
            if (cluster.resources.kind === "native") {
              cluster.resources.process = process;
              cluster.resources.processScope = processScope;
            }
          }),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Scope.close(processScope, Exit.void).pipe(Effect.asVoid),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* waitForPostgres(cluster.port, healthTimeout);
      if (!cluster.bootstrapped) {
        yield* bootstrap(cluster.port, options, healthTimeout);
        cluster.bootstrapped = true;
      }
      yield* waitForAdvertised(cluster.port, password, healthTimeout);
      cluster.running = true;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : stopNative(cluster).pipe(Effect.ignore),
      ),
    );
  });

const startContainer = (
  cluster: Cluster,
  options: CreateEphemeralPostgresOptions,
  healthTimeout: string,
  password: string,
): Effect.Effect<void, EphemeralPostgresError, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    if (cluster.resources.kind !== "container") return;
    const resources = cluster.resources;
    const image = cluster.image;
    if (image === undefined)
      return yield* ephemeralError("Ephemeral Postgres image is unavailable");
    const networkId = resources.networkId;
    const volumeId = resources.volumeId;
    if (networkId === undefined || volumeId === undefined)
      return yield* ephemeralError("Ephemeral Postgres volume is unavailable");
    yield* Effect.gen(function* () {
      if (resources.containerId !== undefined) {
        yield* resources.engine
          .startContainer(resources.containerId)
          .pipe(
            Effect.mapError((cause) =>
              ephemeralError("Unable to start ephemeral Postgres", { cause }),
            ),
          );
      } else {
        const path = yield* Path.Path;
        const envFile = yield* writeEnvFile(
          path.join(cluster.root, "postgres.env"),
          postgresEnv({
            port: 5432,
            dataPath: `${CONTAINER_PGDATA_PARENT}/${PGDATA_DIR_NAME}`,
            password,
          }),
        );
        const created = yield* Effect.uninterruptibleMask((restore) =>
          restore(
            resources.engine.createContainer({
              name: resourceName(cluster.identity, "database"),
              image,
              labels: {
                stackId: cluster.identity,
                ownerSessionId: cluster.identity.slice(0, 32),
                workloadId: DATABASE_WORKLOAD_ID,
                role: "workload",
              },
              network: networkId,
              mounts: [],
              volumeMounts: [
                {
                  volume: volumeId,
                  target: `${CONTAINER_PGDATA_PARENT}/${PGDATA_DIR_NAME}`,
                  readOnly: false,
                },
              ],
              publications: [{ address: "127.0.0.1", hostPort: cluster.port, containerPort: 5432 }],
              role: "workload",
              command: postgresArgs(5432, cluster.runtime, options.postgresSettings),
              envFile,
            }),
          ).pipe(
            Effect.mapError((cause) =>
              ephemeralError("Unable to create ephemeral Postgres", { cause }),
            ),
            Effect.tap((created) =>
              Effect.sync(() => {
                resources.containerId = created.id;
              }),
            ),
          ),
        );
        yield* resources.engine
          .startContainer(created.id)
          .pipe(
            Effect.mapError((cause) =>
              ephemeralError("Unable to start ephemeral Postgres", { cause }),
            ),
          );
      }
      yield* waitForPostgres(cluster.port, healthTimeout);
      if (!cluster.bootstrapped) {
        yield* bootstrap(cluster.port, options, healthTimeout);
        cluster.bootstrapped = true;
      }
      yield* waitForAdvertised(cluster.port, password, healthTimeout);
      cluster.running = true;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : stopContainer(cluster).pipe(Effect.ignore),
      ),
    );
  });

const exportNative = (
  cluster: Cluster,
  tarPath: string,
): Effect.Effect<
  void,
  EphemeralPostgresError,
  ChildProcessSpawnerService | Scope.Scope | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* writeRuntimeMarker(cluster);
    yield* runTar(["-C", cluster.root, "-cf", tarPath, PGDATA_DIR_NAME]);
  });

const exportContainer = (
  cluster: Cluster,
  tarPath: string,
): Effect.Effect<void, EphemeralPostgresError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* writeRuntimeMarker(cluster);
    yield* runVolumeTar(cluster, tarPath, "create");
  });

const restoreNative = (
  cluster: Cluster,
  restoreFrom: string,
): Effect.Effect<
  void,
  EphemeralPostgresError,
  ChildProcessSpawnerService | Scope.Scope | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* runTar(["-C", cluster.root, "-xf", restoreFrom]);
    yield* verifyRestoredMarker(cluster, restoreFrom);
  });

const restoreContainer = (
  cluster: Cluster,
  restoreFrom: string,
): Effect.Effect<void, EphemeralPostgresError, FileSystem.FileSystem | Path.Path> =>
  runVolumeTar(cluster, restoreFrom, "extract");

const peekSnapshotRuntime = (
  restoreFrom: string,
  runtime: StackRuntime,
  peekRoot: string,
): Effect.Effect<
  void,
  EphemeralPostgresError,
  FileSystem.FileSystem | ChildProcessSpawnerService | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(peekRoot, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        ephemeralError("Unable to inspect snapshot", {
          cause,
          path: peekRoot,
          reason: "snapshot",
        }),
      ),
    );
    yield* runTar([
      "-xf",
      restoreFrom,
      "-C",
      peekRoot,
      `${PGDATA_DIR_NAME}/${RUNTIME_MARKER}`,
    ]).pipe(
      Effect.mapError(() =>
        ephemeralError("Ephemeral Postgres snapshot is missing a runtime marker", {
          reason: "restore-mismatch",
          path: restoreFrom,
        }),
      ),
    );
    const marker = yield* fs
      .readFileString(`${peekRoot}/${PGDATA_DIR_NAME}/${RUNTIME_MARKER}`)
      .pipe(
        Effect.mapError((cause) =>
          ephemeralError("Unable to read snapshot runtime marker", { cause, reason: "snapshot" }),
        ),
        Effect.flatMap(decodeMarker),
      );
    if (!sameRuntime(marker, runtime))
      return yield* ephemeralError(
        "Ephemeral Postgres snapshot was produced by a different runtime",
        {
          reason: "restore-mismatch",
          path: restoreFrom,
        },
      );
    yield* fs.remove(peekRoot, { recursive: true }).pipe(Effect.ignore);
  });

const destroyCluster = (cluster: Cluster): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (cluster.resources.kind === "native") yield* stopNative(cluster).pipe(Effect.ignore);
    else {
      yield* stopContainer(cluster).pipe(Effect.ignore);
      if (cluster.resources.containerId !== undefined)
        yield* cluster.resources.engine
          .removeContainer(cluster.resources.containerId)
          .pipe(Effect.ignore);
      if (cluster.resources.volumeId !== undefined)
        yield* cluster.resources.engine
          .removeVolume(cluster.resources.volumeId)
          .pipe(Effect.ignore);
      if (cluster.resources.networkId !== undefined)
        yield* cluster.resources.engine
          .removeNetwork(cluster.resources.networkId)
          .pipe(Effect.ignore);
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(cluster.root, { recursive: true }).pipe(Effect.ignore);
  });

const clusterHandle = (
  cluster: Cluster,
  options: CreateEphemeralPostgresOptions,
  healthTimeout: string,
  password: string,
): EffectEphemeralPostgres => {
  const requireStopped = (): Effect.Effect<void, EphemeralPostgresError> =>
    cluster.running
      ? Effect.fail(
          ephemeralError("Ephemeral Postgres must be stopped before exporting PGDATA", {
            reason: "not-stopped",
          }),
        )
      : Effect.void;
  return {
    host: cluster.host,
    port: cluster.port,
    version: cluster.version,
    runtime: cluster.runtime,
    artifactIdentity: cluster.artifactIdentity,
    url: Redacted.make(databaseUrl(cluster.port, password)),
    start: () =>
      cluster.lifecycle.withPermit(
        Effect.gen(function* () {
          if (cluster.running) {
            if (cluster.runtime.kind === "native" && cluster.resources.kind === "native") {
              const process = cluster.resources.process;
              const stillRunning =
                process === undefined
                  ? false
                  : yield* process.isRunning.pipe(Effect.orElseSucceed(() => false));
              if (stillRunning) return;
              yield* stopNative(cluster).pipe(Effect.ignore);
            } else {
              const probe = yield* waitForPostgres(cluster.port, "1s").pipe(Effect.exit);
              if (Exit.isSuccess(probe)) return;
              cluster.running = false;
            }
          }
          if (cluster.runtime.kind === "native")
            yield* startNative(cluster, options, healthTimeout, password);
          else yield* startContainer(cluster, options, healthTimeout, password);
        }),
      ),
    stop: () =>
      cluster.lifecycle.withPermit(
        cluster.runtime.kind === "native" ? stopNative(cluster) : stopContainer(cluster),
      ),
    exportPgData: (tarPath) =>
      cluster.lifecycle.withPermit(
        Effect.gen(function* () {
          yield* requireStopped();
          if (cluster.runtime.kind === "native") yield* exportNative(cluster, tarPath);
          else yield* exportContainer(cluster, tarPath);
        }),
      ),
  };
};

export const createEphemeralPostgresCluster = (
  options: CreateEphemeralPostgresOptions,
): Effect.Effect<
  EffectEphemeralPostgres,
  EphemeralPostgresCreateError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const runtime = resolvedRuntime(options.runtime);
    const release = yield* resolveEphemeralPostgresRelease(options.version);
    const env = yield* Effect.serviceOption(StackRuntimeEnvironment).pipe(
      Effect.map(Option.getOrElse(defaultRuntimeEnvironment)),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const identity = yield* createIdentity(crypto);
    const root = path.join(path.dirname(env.stateRoot), "ephemeral-postgres", identity);
    const dataPath = path.join(root, PGDATA_DIR_NAME);
    yield* fs.makeDirectory(dataPath, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({
            message: "Unable to create ephemeral Postgres data directory",
            path: dataPath,
            cause,
          }),
      ),
    );
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    if (options.restoreFrom !== undefined)
      yield* peekSnapshotRuntime(options.restoreFrom, runtime, path.join(root, "peek"));
    const port = yield* allocateLoopbackPort(options.port);
    const healthTimeout = options.healthTimeout ?? DEFAULT_DATABASE_HEALTH_TIMEOUT;
    const password = Redacted.value(options.databasePassword);
    const workload = plannedWorkload(release.version, release.image, runtime);
    const preparer = yield* makeProductionRuntimeArtifactPreparer({
      stateRoot: env.stateRoot,
      ...(env.artifactCacheRoot === undefined ? {} : { artifactCacheRoot: env.artifactCacheRoot }),
      runtime,
    });
    const prepared = yield* preparer.prepare(runtime, workload);
    let resources: RuntimeResources;
    if (runtime.kind === "native") {
      resources = { kind: "native" };
    } else {
      const resolver = yield* Effect.serviceOption(ContainerEngineResolver).pipe(
        Effect.map(Option.getOrUndefined),
      );
      const engine = yield* resolveContainerEngine(runtime.engine, resolver).pipe(
        Effect.mapError(
          (cause) =>
            new ContainerEngineError({
              message: `Unable to configure ${runtime.engine} for ephemeral Postgres`,
              engine: runtime.engine,
              cause,
            }),
        ),
      );
      resources = { kind: "container", engine };
    }
    const cluster: Cluster = {
      identity,
      root,
      dataPath,
      host: "127.0.0.1",
      port,
      version: release.version,
      runtime,
      artifactIdentity:
        runtime.kind === "native"
          ? `native:${release.version}`
          : `container:${runtime.engine}:${release.image}`,
      ...(prepared.executablePath === undefined || prepared.artifactRoot === undefined
        ? {}
        : {
            executable: prepared.artifactRoot.endsWith("/")
              ? `${prepared.artifactRoot}${prepared.executablePath}`
              : `${prepared.artifactRoot}/${prepared.executablePath}`,
          }),
      ...(prepared.image === undefined ? {} : { image: prepared.image }),
      lifecycle: Semaphore.makeUnsafe(1),
      running: false,
      bootstrapped: options.restoreFrom !== undefined,
      resources,
    };
    yield* Effect.addFinalizer(() => destroyCluster(cluster));
    if (cluster.resources.kind === "container") {
      const resources = cluster.resources;
      const engine = resources.engine;
      const engineKind = cluster.runtime.kind === "container" ? cluster.runtime.engine : "docker";
      yield* Effect.uninterruptibleMask((restore) =>
        restore(
          engine.createNetwork({
            name: resourceName(identity, "network"),
            labels: { stackId: identity, ownerSessionId: identity.slice(0, 32), role: "network" },
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ContainerEngineError({
                message: "Unable to create ephemeral Postgres network",
                engine: engineKind,
                cause,
              }),
          ),
          Effect.tap((created) =>
            Effect.sync(() => {
              resources.networkId = created.id;
            }),
          ),
        ),
      );
      yield* Effect.uninterruptibleMask((restore) =>
        restore(
          engine.createVolume({
            name: resourceName(identity, "database-volume"),
            labels: { stackId: identity, workloadId: DATABASE_WORKLOAD_ID, role: "volume" },
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ContainerEngineError({
                message: "Unable to create ephemeral Postgres volume",
                engine: engineKind,
                cause,
              }),
          ),
          Effect.tap((created) =>
            Effect.sync(() => {
              resources.volumeId = created.id;
            }),
          ),
        ),
      );
    }
    if (options.restoreFrom !== undefined) {
      if (runtime.kind === "native") yield* restoreNative(cluster, options.restoreFrom);
      else yield* restoreContainer(cluster, options.restoreFrom);
    }
    if (runtime.kind === "native") yield* startNative(cluster, options, healthTimeout, password);
    else yield* startContainer(cluster, options, healthTimeout, password);
    return clusterHandle(cluster, options, healthTimeout, password);
  });

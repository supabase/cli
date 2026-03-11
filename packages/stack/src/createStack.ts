import type { LogEntry, ServiceNotFoundError } from "@supabase/process-compose";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Duration, Effect, type Layer, ManagedRuntime, Stream } from "effect";
import { FileSystem, Path } from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { cleanupAutoManagedDataDir, dockerForceRemove } from "./cleanup.ts";
import { toStackError } from "./errors.ts";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";
import {
  daemonLayer,
  foregroundLayer,
  type DaemonConfig,
  type DaemonStartError,
} from "./layers.ts";
import { StackAlreadyRunningError } from "./StateManager.ts";
import { Stack } from "./Stack.ts";
import type { StackServiceState } from "./StackServiceState.ts";
import { allocatePorts, type AllocatedPorts } from "./PortAllocator.ts";
import {
  type AuthConfig,
  type PostgrestConfig,
  type ResolvedAuthConfig,
  type ResolvedPostgrestConfig,
  type ResolvedStackConfig,
  type StackConfig,
} from "./StackBuilder.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

/**
 * The minimum set of platform services required to run a local stack.
 * Platform entry points (bun.ts, node.ts) provide layers that satisfy this type.
 */
export type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpServer.HttpServer;

/**
 * A layer that provides all required platform services.
 * Platform-specific layers may provide additional services (e.g. BunServices)
 * beyond the minimum required set.
 */
export type PlatformLayer = Layer.Layer<PlatformServices>;

/** Factory that creates a platform layer given the resolved API port. */
export type PlatformFactory = (apiPort: number) => PlatformLayer;

export interface ReadyOptions {
  readonly timeout?: number;
}

export interface StackHandle extends AsyncDisposable {
  // Connection info
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;

  // Stack lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;

  // Per-service lifecycle
  startService(name: string): Promise<void>;
  stopService(name: string): Promise<void>;
  restartService(name: string): Promise<void>;

  // Readiness
  ready(opts?: ReadyOptions): Promise<void>;
  serviceReady(name: string, opts?: ReadyOptions): Promise<void>;

  // Status
  getStatus(): Promise<ReadonlyArray<StackServiceState>>;
  getServiceStatus(name: string): Promise<StackServiceState>;
  statusChanges(): AsyncIterable<StackServiceState>;

  // Logs
  logs(): AsyncIterable<LogEntry>;
  serviceLogs(name: string): AsyncIterable<LogEntry>;
  logHistory(name: string, limit?: number): Promise<ReadonlyArray<LogEntry>>;
}

function resolvePostgrestConfig(
  input: PostgrestConfig | undefined,
  raw: PostgrestConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedPostgrestConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: ports.postgrestPort,
    adminPort: ports.postgrestAdminPort,
    schemas: cfg.schemas ?? ["public"],
    extraSearchPath: cfg.extraSearchPath ?? ["public", "extensions"],
    maxRows: cfg.maxRows ?? 1000,
    version: cfg.version ?? DEFAULT_VERSIONS.postgrest,
  };
}

function resolveAuthConfig(
  input: AuthConfig | undefined,
  raw: AuthConfig | false | undefined,
  ports: AllocatedPorts,
  apiPort: number,
): ResolvedAuthConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: ports.authPort,
    siteUrl: cfg.siteUrl ?? "http://localhost:3000",
    jwtExpiry: cfg.jwtExpiry ?? 3600,
    externalUrl: cfg.externalUrl ?? `http://127.0.0.1:${apiPort}`,
    version: cfg.version ?? DEFAULT_VERSIONS.auth,
  };
}

/** Resolve user-facing StackConfig into a fully resolved ResolvedStackConfig. */
export async function resolveConfig(input?: StackConfig): Promise<ResolvedStackConfig> {
  const config = input ?? {};
  const home = config.home ?? join(homedir(), ".supabase");
  const postgresInput = config.postgres ?? {};
  const postgrestInput = config.postgrest !== false ? (config.postgrest ?? undefined) : undefined;
  const authInput = config.auth !== false ? (config.auth ?? undefined) : undefined;

  const autoManagedDataDir = postgresInput.dataDir == null;
  const dataDir = postgresInput.dataDir ?? mkdtempSync(join(tmpdir(), "supabase-local-"));

  const ports = await Effect.runPromise(
    allocatePorts({
      apiPort: config.port,
      dbPort: postgresInput.port,
      authPort: authInput?.port,
      postgrestPort: undefined,
      postgrestAdminPort: undefined,
    }),
  ).catch((e: unknown) => {
    throw toStackError(e);
  });

  const jwtSecret = config.jwtSecret ?? defaultJwtSecret;
  const anonJwt = generateJwt(jwtSecret, "anon");
  const serviceRoleJwt = generateJwt(jwtSecret, "service_role");

  return {
    home,
    mode: config.mode ?? "auto",
    jwtSecret,
    apiPort: ports.apiPort,
    dbPort: ports.dbPort,
    publishableKey: config.publishableKey ?? defaultPublishableKey,
    secretKey: config.secretKey ?? defaultSecretKey,
    autoManagedDataDir,
    anonJwt,
    serviceRoleJwt,

    postgres: {
      port: ports.dbPort,
      dataDir,
      version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
    },

    postgrest: resolvePostgrestConfig(postgrestInput, config.postgrest, ports),

    auth: resolveAuthConfig(authInput, config.auth, ports, ports.apiPort),
  };
}

export async function resolveDaemonConfig(
  input: StackConfig & {
    readonly cwd: string;
    readonly name?: string;
    readonly projectDir?: string;
  },
): Promise<DaemonConfig> {
  const { cwd, name, projectDir, ...stackConfig } = input;
  const resolved = await resolveConfig(stackConfig);
  const effectiveProjectDir = projectDir ?? cwd;
  return {
    ...resolved,
    name: name ?? (basename(effectiveProjectDir) || "default"),
    projectDir: effectiveProjectDir,
  };
}

export const projectDaemonLayer = (opts: {
  readonly home: string;
  readonly cwd: string;
  readonly daemonEntryPoint: string;
  readonly stackConfig?: Omit<StackConfig, "home">;
}): Effect.Effect<
  Layer.Layer<Stack>,
  DaemonStartError | StackAlreadyRunningError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const config = yield* Effect.promise(() =>
      resolveDaemonConfig({
        home: opts.home,
        cwd: opts.cwd,
        ...opts.stackConfig,
      }),
    );
    return yield* daemonLayer(config, opts.daemonEntryPoint);
  });

/** Compute all possible Docker container names from a resolved config (for error-path cleanup). */
function dockerContainerNamesFor(config: ResolvedStackConfig): string[] {
  const names = [`supabase-postgres-${config.apiPort}`];
  if (config.postgrest !== false) names.push(`supabase-postgrest-${config.apiPort}`);
  if (config.auth !== false) names.push(`supabase-auth-${config.apiPort}`);
  return names;
}

export async function createStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
): Promise<StackHandle> {
  const resolved = await resolveConfig(config);
  const fullLayer = foregroundLayer(resolved, platformFactory);
  const runtime = ManagedRuntime.make(fullLayer);

  try {
    // Get the services map for Stream bridging (materializes layers, binds HttpServer)
    const services = await runtime.services();

    // Get Stack instance once — its methods return Effects/Streams directly
    const localStack = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Stack;
      }),
    );

    // Get stack info
    const info = await runtime.runPromise(localStack.getInfo());

    // Helper to run effects with error mapping
    const run = <A>(effect: Effect.Effect<A, unknown>) =>
      runtime.runPromise(effect).catch((e: unknown) => {
        throw toStackError(e);
      });

    const gracefulDispose = async () => {
      await runtime.dispose().catch(() => {});
    };

    const stack: StackHandle = {
      url: info.url,
      dbUrl: info.dbUrl,
      publishableKey: info.publishableKey,
      secretKey: info.secretKey,

      start: () => run(localStack.start()),
      stop: () => run(localStack.stop()),
      dispose: gracefulDispose,

      startService: (name: string) => run(localStack.startService(name)),
      stopService: (name: string) => run(localStack.stopService(name)),
      restartService: (name: string) => run(localStack.restartService(name)),

      ready: (opts?: ReadyOptions) => {
        const effect =
          opts?.timeout != null
            ? localStack.waitAllReady().pipe(Effect.timeout(Duration.millis(opts.timeout)))
            : localStack.waitAllReady();
        return run(effect);
      },
      serviceReady: (name: string, opts?: ReadyOptions) => {
        const effect =
          opts?.timeout != null
            ? localStack.waitReady(name).pipe(Effect.timeout(Duration.millis(opts.timeout)))
            : localStack.waitReady(name);
        return run(effect);
      },

      getStatus: () => run(localStack.getAllStates()),
      getServiceStatus: (name: string) =>
        run(localStack.getState(name) as Effect.Effect<StackServiceState, ServiceNotFoundError>),

      statusChanges: () => Stream.toAsyncIterableWith(localStack.allStateChanges(), services),

      logs: () => Stream.toAsyncIterableWith(localStack.subscribeAllLogs(), services),

      serviceLogs: (name: string) =>
        Stream.toAsyncIterableWith(localStack.subscribeLogs(name), services),

      logHistory: (name: string, limit?: number) => run(localStack.logHistory(name, limit)),

      [Symbol.asyncDispose]: gracefulDispose,
    };

    return stack;
  } catch (e: unknown) {
    // Dispose the runtime to clean up any partially-materialized layers
    // (e.g. spawned postgres/docker processes) before propagating the error.
    await runtime.dispose().catch(() => {});
    // Clean up any Docker containers from partial startup
    dockerForceRemove(dockerContainerNamesFor(resolved));
    cleanupAutoManagedDataDir(resolved);
    throw toStackError(e);
  }
}

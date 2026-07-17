import type { LogEntry } from "@supabase/process-compose";
import { readdir, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Duration, Effect, type Layer, ManagedRuntime, Schema, Stream } from "effect";
import { FileSystem, Path } from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { cleanupAutoManagedPaths, dockerForceRemove } from "./cleanup.ts";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { toStackError } from "./errors.ts";
import type { FunctionsConfig } from "./functions.ts";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";
import { resolvePostgresPassword } from "./postgresCredentials.ts";
import {
  daemonLayer,
  foregroundLayer,
  type DaemonConfig,
  type DaemonStartError,
} from "./layers.ts";
import {
  DEFAULT_MANAGED_STACK_NAME,
  defaultCacheRoot,
  defaultManagedProjectsRoot,
  defaultManagedRuntimeRoot,
  defaultManagedStackRoot,
  shortTempPrefixRoot,
} from "./paths.ts";
import { allocatePorts, DEFAULT_PORTS, PORT_FIELDS, type AllocatedPorts } from "./PortAllocator.ts";
import type { PortInput } from "./PortAllocator.ts";
import { acquirePortLease } from "./PortLease.ts";
import { StackMetadataSchema } from "./StackMetadata.ts";
import { InvalidStackStateError, StackAlreadyRunningError } from "./StateManager.ts";
import { Stack } from "./Stack.ts";
import type { EdgeRuntimeReloadConfig } from "./Stack.ts";
import type { StackServiceState } from "./StackServiceState.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";
import type {
  AnalyticsConfig,
  AuthConfig,
  EdgeRuntimeConfig,
  ImgproxyConfig,
  MailpitConfig,
  PgmetaConfig,
  PoolerConfig,
  PostgrestConfig,
  RealtimeConfig,
  ResolvedAnalyticsConfig,
  ResolvedAuthConfig,
  ResolvedEdgeRuntimeConfig,
  ResolvedImgproxyConfig,
  ResolvedMailpitConfig,
  ResolvedPgmetaConfig,
  ResolvedPoolerConfig,
  ResolvedPostgrestConfig,
  ResolvedRealtimeConfig,
  ResolvedStackConfig,
  ResolvedStorageConfig,
  ResolvedStudioConfig,
  ResolvedVectorConfig,
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackBuilder.ts";
import { DEFAULT_VERSIONS, STACK_SERVICE_NAMES, type StackServiceName } from "./versions.ts";

const StackMetadataFileSchema = Schema.fromJsonString(StackMetadataSchema);
const decodeStackMetadataFile = Schema.decodeUnknownSync(StackMetadataFileSchema);

export type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpServer.HttpServer;

export type PlatformLayer = Layer.Layer<PlatformServices>;
export type PlatformFactory = (apiPort: number) => PlatformLayer;

export interface ReadyOptions {
  readonly timeout?: number;
}

export function defaultManagedStackName(_cwd: string): string {
  return DEFAULT_MANAGED_STACK_NAME;
}

export interface StackHandle extends AsyncDisposable {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  startService(name: string): Promise<void>;
  stopService(name: string): Promise<void>;
  restartService(name: string): Promise<void>;
  ensureExtensionPreload(name: string): Promise<void>;
  reloadFunctions(opts?: FunctionsConfig): Promise<void>;
  reloadEdgeRuntime(opts: EdgeRuntimeReloadConfig): Promise<void>;
  ready(opts?: ReadyOptions): Promise<void>;
  serviceReady(name: string, opts?: ReadyOptions): Promise<void>;
  getStatus(): Promise<ReadonlyArray<StackServiceState>>;
  getServiceStatus(name: string): Promise<StackServiceState>;
  statusChanges(): AsyncIterable<StackServiceState>;
  logs(): AsyncIterable<LogEntry>;
  serviceLogs(name: string): AsyncIterable<LogEntry>;
  logHistory(name: string, limit?: number): Promise<ReadonlyArray<LogEntry>>;
}

interface ResolveConfigOptions {
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly preferredPorts?: Partial<AllocatedPorts>;
  readonly reservedPorts?: ReadonlySet<number>;
  readonly allocatedPorts?: AllocatedPorts;
}

interface ResolvedRoots {
  readonly cacheRoot: string;
  readonly stackRoot: string;
  readonly runtimeRoot: string;
  readonly autoManagedPaths: ReadonlyArray<string>;
}

const makeTempRoot = (prefix: string) => mkdtempSync(join(shortTempPrefixRoot(), prefix));

const resolveRoots = (config: StackConfig, opts: ResolveConfigOptions): ResolvedRoots => {
  const cacheRoot = config.cacheRoot ?? defaultCacheRoot();
  const autoManagedPaths: string[] = [];

  const stackRoot =
    opts.stackRoot ??
    config.stackRoot ??
    (() => {
      const dir = makeTempRoot("sb-stack-");
      autoManagedPaths.push(dir);
      return dir;
    })();

  const runtimeRoot =
    opts.runtimeRoot ??
    config.runtimeRoot ??
    (() => {
      const dir = makeTempRoot("sb-run-");
      autoManagedPaths.push(dir);
      return dir;
    })();

  return {
    cacheRoot,
    stackRoot,
    runtimeRoot,
    autoManagedPaths,
  };
};

const resolveDataDir = (
  explicitDir: string | undefined,
  stackRoot: string,
  suffix: string,
): string => explicitDir ?? join(stackRoot, "data", suffix);

async function readStackMetadataFile(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");
    return decodeStackMetadataFile(content);
  } catch {
    return undefined;
  }
}

async function readOwnedPorts(stackRoot: string): Promise<AllocatedPorts | undefined> {
  const metadata = await readStackMetadataFile(join(stackRoot, "stack.json"));
  return metadata?.ports;
}

async function readReservedPorts(
  projectsRoot: string,
  currentStackRoot: string,
): Promise<ReadonlySet<number>> {
  const reserved = new Set<number>();

  let projectEntries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    projectEntries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return reserved;
  }

  await Promise.all(
    projectEntries.map(async (projectEntry) => {
      if (!projectEntry.isDirectory()) {
        return;
      }

      const stacksRoot = join(projectsRoot, projectEntry.name, "stacks");
      let stackEntries: Array<{ isDirectory(): boolean; name: string }>;
      try {
        stackEntries = await readdir(stacksRoot, { withFileTypes: true });
      } catch {
        return;
      }

      await Promise.all(
        stackEntries.map(async (stackEntry) => {
          if (!stackEntry.isDirectory()) {
            return;
          }

          const stackRoot = join(stacksRoot, stackEntry.name);
          if (stackRoot === currentStackRoot) {
            return;
          }

          const ports = (await readStackMetadataFile(join(stackRoot, "stack.json")))?.ports;
          if (ports === undefined) {
            return;
          }

          for (const field of PORT_FIELDS) {
            reserved.add(ports[field]);
          }
        }),
      );
    }),
  );

  return reserved;
}

async function readReservedPortsInStacksRoot(
  stacksRoot: string,
  currentStackRoot: string,
): Promise<ReadonlySet<number>> {
  const reserved = new Set<number>();

  let stackEntries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    stackEntries = await readdir(stacksRoot, { withFileTypes: true });
  } catch {
    return reserved;
  }

  await Promise.all(
    stackEntries.map(async (stackEntry) => {
      if (!stackEntry.isDirectory()) {
        return;
      }

      const stackRoot = join(stacksRoot, stackEntry.name);
      if (stackRoot === currentStackRoot) {
        return;
      }

      const ports = (await readStackMetadataFile(join(stackRoot, "stack.json")))?.ports;
      if (ports === undefined) {
        return;
      }

      for (const field of PORT_FIELDS) {
        reserved.add(ports[field]);
      }
    }),
  );

  return reserved;
}

function resolvePostgrestConfig(
  input: PostgrestConfig | undefined,
  ports: AllocatedPorts,
): ResolvedPostgrestConfig {
  const cfg = input ?? {};
  return {
    port: ports.postgrestPort,
    adminPort: ports.postgrestAdminPort,
    schemas: cfg.schemas ?? ["public", "graphql_public"],
    extraSearchPath: cfg.extraSearchPath ?? ["public", "extensions"],
    maxRows: cfg.maxRows ?? 1000,
    version: cfg.version ?? DEFAULT_VERSIONS.postgrest,
  };
}

function resolveAuthConfig(
  input: AuthConfig | undefined,
  ports: AllocatedPorts,
  apiPort: number,
): ResolvedAuthConfig {
  const cfg = input ?? {};
  return {
    port: ports.authPort,
    siteUrl: cfg.siteUrl ?? "http://localhost:3000",
    jwtExpiry: cfg.jwtExpiry ?? 3600,
    externalUrl: cfg.externalUrl ?? `http://127.0.0.1:${apiPort}`,
    version: cfg.version ?? DEFAULT_VERSIONS.auth,
  };
}

function resolveRealtimeConfig(
  input: RealtimeConfig | undefined,
  ports: AllocatedPorts,
): ResolvedRealtimeConfig {
  const cfg = input ?? {};
  return {
    port: ports.realtimePort,
    version: cfg.version ?? DEFAULT_VERSIONS.realtime,
    tenantId: cfg.tenantId ?? "realtime-dev",
    encryptionKey: cfg.encryptionKey ?? "supabaserealtime",
    secretKeyBase:
      cfg.secretKeyBase ?? "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
    maxHeaderLength: cfg.maxHeaderLength ?? 4096,
  };
}

function resolveEdgeRuntimeConfig(
  input: EdgeRuntimeConfig | undefined,
  ports: AllocatedPorts,
): ResolvedEdgeRuntimeConfig {
  const cfg = input ?? {};
  return {
    enabled: true,
    port: ports.edgeRuntimePort,
    inspectorPort: ports.edgeRuntimeInspectorPort,
    policy: cfg.policy ?? "per_worker",
    version: cfg.version ?? DEFAULT_VERSIONS["edge-runtime"],
    env: cfg.env ?? {},
  };
}

function resolveFunctionsConfig(config: StackConfig) {
  if (config.functions === false) return false;
  return {
    envFile: config.functions?.envFile,
    noVerifyJwt: config.functions?.noVerifyJwt ?? false,
  };
}

function resolveStorageConfig(
  input: StorageConfig | undefined,
  ports: AllocatedPorts,
  opts: ResolveConfigOptions,
): ResolvedStorageConfig {
  const cfg = input ?? {};
  return {
    port: ports.storagePort,
    version: cfg.version ?? DEFAULT_VERSIONS.storage,
    dataDir: resolveDataDir(cfg.dataDir, opts.stackRoot!, "storage"),
    fileSizeLimit: cfg.fileSizeLimit ?? "50MiB",
    s3ProtocolEnabled: cfg.s3ProtocolEnabled ?? true,
  };
}

function resolveImgproxyConfig(
  input: ImgproxyConfig | undefined,
  ports: AllocatedPorts,
): ResolvedImgproxyConfig {
  const cfg = input ?? {};
  return {
    port: ports.imgproxyPort,
    version: cfg.version ?? DEFAULT_VERSIONS.imgproxy,
  };
}

function resolveMailpitConfig(
  input: MailpitConfig | undefined,
  ports: AllocatedPorts,
): ResolvedMailpitConfig {
  const cfg = input ?? {};
  return {
    port: ports.mailpitPort,
    smtpPort: ports.mailpitSmtpPort,
    pop3Port: ports.mailpitPop3Port,
    version: cfg.version ?? DEFAULT_VERSIONS.mailpit,
    adminEmail: cfg.adminEmail ?? "admin@email.com",
    senderName: cfg.senderName ?? "Admin",
  };
}

function resolvePgmetaConfig(
  input: PgmetaConfig | undefined,
  ports: AllocatedPorts,
): ResolvedPgmetaConfig {
  const cfg = input ?? {};
  return {
    port: ports.pgmetaPort,
    version: cfg.version ?? DEFAULT_VERSIONS.pgmeta,
  };
}

function resolveStudioConfig(
  input: StudioConfig | undefined,
  ports: AllocatedPorts,
  apiPort: number,
): ResolvedStudioConfig {
  const cfg = input ?? {};
  return {
    port: ports.studioPort,
    version: cfg.version ?? DEFAULT_VERSIONS.studio,
    apiUrl: cfg.apiUrl ?? `http://127.0.0.1:${apiPort}`,
  };
}

function resolveAnalyticsConfig(
  input: AnalyticsConfig | undefined,
  ports: AllocatedPorts,
): ResolvedAnalyticsConfig {
  const cfg = input ?? {};
  return {
    port: ports.analyticsPort,
    version: cfg.version ?? DEFAULT_VERSIONS.analytics,
    backend: cfg.backend ?? "postgres",
    apiKey: cfg.apiKey ?? "api-key",
  };
}

function resolveVectorConfig(input: VectorConfig | undefined): ResolvedVectorConfig {
  const cfg = input ?? {};
  return {
    version: cfg.version ?? DEFAULT_VERSIONS.vector,
  };
}

function resolvePoolerConfig(
  input: PoolerConfig | undefined,
  ports: AllocatedPorts,
): ResolvedPoolerConfig {
  const cfg = input ?? {};
  return {
    port: ports.poolerPort,
    apiPort: ports.poolerApiPort,
    mode: cfg.mode ?? "transaction",
    version: cfg.version ?? DEFAULT_VERSIONS.pooler,
    tenantId: cfg.tenantId ?? "pooler-dev",
    encryptionKey: cfg.encryptionKey ?? "12345678901234567890123456789032",
    secretKeyBase:
      cfg.secretKeyBase ?? "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
    defaultPoolSize: cfg.defaultPoolSize ?? 20,
    maxClientConn: cfg.maxClientConn ?? 100,
  };
}

export async function resolveConfig(
  input?: StackConfig,
  opts: ResolveConfigOptions = {},
): Promise<ResolvedStackConfig> {
  const config = input ?? {};
  const projectDir = config.projectDir ?? process.cwd();
  const resolvedMode = config.mode ?? "auto";
  const roots = resolveRoots(config, opts);
  const postgresInput = config.postgres ?? {};
  // Docker-only sidecars cannot be made available in native mode. Keep the native default
  // useful without silently selecting services that the requested runtime can never start.
  const requestedServices =
    config.services ??
    (resolvedMode === "native"
      ? (["postgrest", "auth"] satisfies StackServiceName[])
      : STACK_SERVICE_NAMES);
  const knownServices = new Set<string>(STACK_SERVICE_NAMES);
  const enabledServices = new Set<StackServiceName>();
  for (const service of requestedServices) {
    if (!knownServices.has(service)) throw new Error(`Unknown stack service: ${service}`);
    if (enabledServices.has(service)) throw new Error(`Duplicate stack service: ${service}`);
    enabledServices.add(service);
  }
  const serviceInputs = {
    postgrest: config.postgrest,
    auth: config.auth,
    "edge-runtime": config.edgeRuntime,
    realtime: config.realtime,
    storage: config.storage,
    imgproxy: config.imgproxy,
    mailpit: config.mailpit,
    pgmeta: config.pgmeta,
    studio: config.studio,
    analytics: config.analytics,
    vector: config.vector,
    pooler: config.pooler,
  } satisfies Record<StackServiceName, unknown>;
  for (const service of STACK_SERVICE_NAMES) {
    if (serviceInputs[service] !== undefined && !enabledServices.has(service)) {
      throw new Error(
        `Configuration for ${service} was provided, but ${service} is not listed in services`,
      );
    }
  }
  const startServices = config.startServices ?? [];
  const eagerServices = new Set<StackServiceName>();
  for (const service of startServices) {
    if (!knownServices.has(service)) throw new Error(`Unknown start service: ${service}`);
    if (!enabledServices.has(service)) {
      throw new Error(`Start service ${service} is not listed in services`);
    }
    if (eagerServices.has(service)) throw new Error(`Duplicate start service: ${service}`);
    eagerServices.add(service);
  }
  if (
    config.functions !== undefined &&
    config.functions !== false &&
    !enabledServices.has("edge-runtime")
  ) {
    throw new Error('functions configuration requires "edge-runtime" in services');
  }

  const postgrestEnabled = enabledServices.has("postgrest");
  const authEnabled = enabledServices.has("auth");
  const edgeRuntimeEnabled = enabledServices.has("edge-runtime");
  const realtimeEnabled = enabledServices.has("realtime");
  const storageEnabled = enabledServices.has("storage");
  const imgproxyEnabled = enabledServices.has("imgproxy");
  const mailpitEnabled = enabledServices.has("mailpit");
  const pgmetaEnabled = enabledServices.has("pgmeta");
  const studioEnabled = enabledServices.has("studio");
  const analyticsEnabled = enabledServices.has("analytics");
  const vectorEnabled = enabledServices.has("vector");
  const poolerEnabled = enabledServices.has("pooler");

  const postgresDataDir = resolveDataDir(postgresInput.dataDir, roots.stackRoot, "postgres");

  const ports =
    opts.allocatedPorts ??
    (await Effect.runPromise(
      allocatePorts(portInputForConfig(config), {
        preferred: opts.preferredPorts,
        reserved: opts.reservedPorts,
      }),
    ).catch((error: unknown) => {
      throw toStackError(error);
    }));

  const jwtSecret = config.jwtSecret ?? defaultJwtSecret;
  const anonJwt = generateJwt(jwtSecret, "anon");
  const serviceRoleJwt = generateJwt(jwtSecret, "service_role");

  return {
    cacheRoot: roots.cacheRoot,
    stackRoot: roots.stackRoot,
    runtimeRoot: roots.runtimeRoot,
    projectDir,
    mode: resolvedMode,
    jwtSecret,
    startServices: [...eagerServices],
    ports,
    apiPort: ports.apiPort,
    dbPort: ports.dbPort,
    publishableKey: config.publishableKey ?? defaultPublishableKey,
    secretKey: config.secretKey ?? defaultSecretKey,
    functions: resolveFunctionsConfig(config),
    autoManagedPaths: roots.autoManagedPaths,
    anonJwt,
    serviceRoleJwt,
    postgres: {
      port: ports.dbPort,
      dataDir: postgresDataDir,
      version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
      password: resolvePostgresPassword(postgresInput.password),
      autoExposeNewTables: postgresInput.autoExposeNewTables ?? true,
      provisioned: postgresInput.provisioned,
      profile: postgresInput.profile,
    },
    postgrest: postgrestEnabled ? resolvePostgrestConfig(config.postgrest, ports) : false,
    auth: authEnabled ? resolveAuthConfig(config.auth, ports, ports.apiPort) : false,
    edgeRuntime: edgeRuntimeEnabled ? resolveEdgeRuntimeConfig(config.edgeRuntime, ports) : false,
    realtime: realtimeEnabled ? resolveRealtimeConfig(config.realtime, ports) : false,
    storage: storageEnabled
      ? resolveStorageConfig(config.storage, ports, {
          ...opts,
          stackRoot: roots.stackRoot,
        })
      : false,
    imgproxy: imgproxyEnabled ? resolveImgproxyConfig(config.imgproxy, ports) : false,
    mailpit: mailpitEnabled ? resolveMailpitConfig(config.mailpit, ports) : false,
    pgmeta: pgmetaEnabled ? resolvePgmetaConfig(config.pgmeta, ports) : false,
    studio: studioEnabled ? resolveStudioConfig(config.studio, ports, ports.apiPort) : false,
    analytics: analyticsEnabled ? resolveAnalyticsConfig(config.analytics, ports) : false,
    vector: vectorEnabled ? resolveVectorConfig(config.vector) : false,
    pooler: poolerEnabled ? resolvePoolerConfig(config.pooler, ports) : false,
  };
}

function portInputForConfig(config: StackConfig): PortInput {
  return {
    apiPort: config.port,
    dbPort: config.postgres?.port,
    authPort: config.auth?.port,
    postgrestPort: config.postgrest?.port,
    postgrestAdminPort: config.postgrest?.adminPort,
    edgeRuntimePort: config.edgeRuntime?.port,
    edgeRuntimeInspectorPort: config.edgeRuntime?.inspectorPort,
    realtimePort: config.realtime?.port,
    storagePort: config.storage?.port,
    imgproxyPort: config.imgproxy?.port,
    mailpitPort: config.mailpit?.port,
    mailpitSmtpPort: config.mailpit?.smtpPort,
    mailpitPop3Port: config.mailpit?.pop3Port,
    pgmetaPort: config.pgmeta?.port,
    studioPort: config.studio?.port,
    analyticsPort: config.analytics?.port,
    poolerPort: config.pooler?.port,
    poolerApiPort: config.pooler?.apiPort,
  };
}

export async function resolveDaemonConfig(
  input: StackConfig & {
    readonly cwd: string;
    readonly name?: string;
    readonly projectDir?: string;
    readonly projectStateRoot?: string;
  },
): Promise<DaemonConfig> {
  const { cwd, name, projectDir, projectStateRoot, ...stackConfig } = input;
  if (stackConfig.stackRoot !== undefined || stackConfig.runtimeRoot !== undefined) {
    throw new Error("Managed daemon stacks derive stackRoot and runtimeRoot automatically");
  }
  const effectiveProjectDir = projectDir ?? cwd;
  const resolvedName = name ?? defaultManagedStackName(effectiveProjectDir);
  const cacheRoot = stackConfig.cacheRoot ?? defaultCacheRoot();
  const stackRoot =
    projectStateRoot !== undefined
      ? join(projectStateRoot, "stacks", resolvedName)
      : defaultManagedStackRoot(cacheRoot, effectiveProjectDir, resolvedName);
  const runtimeRoot = defaultManagedRuntimeRoot(stackRoot);
  const savedPorts = await readOwnedPorts(stackRoot);
  const reservedPortSets = await Promise.all([
    readReservedPorts(defaultManagedProjectsRoot(cacheRoot), stackRoot),
    projectStateRoot === undefined
      ? Promise.resolve<ReadonlySet<number>>(new Set())
      : readReservedPortsInStacksRoot(join(projectStateRoot, "stacks"), stackRoot),
  ]);
  const reservedPorts = new Set<number>();
  for (const ports of reservedPortSets) {
    for (const port of ports) {
      reservedPorts.add(port);
    }
  }
  const resolved = await resolveConfig(
    {
      ...stackConfig,
      cacheRoot,
      stackRoot,
      runtimeRoot,
      projectDir: effectiveProjectDir,
    },
    {
      stackRoot,
      runtimeRoot,
      preferredPorts: savedPorts ?? DEFAULT_PORTS,
      reservedPorts,
    },
  );
  return {
    ...resolved,
    name: resolvedName,
    projectDir: effectiveProjectDir,
  };
}

export const projectDaemonLayer = (opts: {
  readonly cacheRoot: string;
  readonly cwd: string;
  readonly projectDir?: string;
  readonly projectStateRoot?: string;
  readonly name?: string;
  readonly daemonEntryPoint: string;
  readonly stackConfig?: Omit<StackConfig, "cacheRoot" | "stackRoot" | "runtimeRoot">;
}): Effect.Effect<
  Layer.Layer<Stack>,
  DaemonStartError | InvalidStackStateError | StackAlreadyRunningError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    const config = yield* Effect.promise(() =>
      resolveDaemonConfig({
        cacheRoot: opts.cacheRoot,
        cwd: opts.cwd,
        projectDir: opts.projectDir,
        projectStateRoot: opts.projectStateRoot,
        name: opts.name,
        ...opts.stackConfig,
      }),
    );
    return yield* daemonLayer(config, opts.daemonEntryPoint);
  });

function possibleCleanupTargetsForConfig(config: ResolvedStackConfig): CleanupTargets {
  const dockerContainerNames = [`supabase-postgres-${config.apiPort}`];
  if (config.postgrest !== false) dockerContainerNames.push(`supabase-postgrest-${config.apiPort}`);
  if (config.auth !== false) dockerContainerNames.push(`supabase-auth-${config.apiPort}`);
  if (config.edgeRuntime !== false)
    dockerContainerNames.push(`supabase-edge-runtime-${config.apiPort}`);
  if (config.realtime !== false) dockerContainerNames.push(`supabase-realtime-${config.apiPort}`);
  if (config.storage !== false) dockerContainerNames.push(`supabase-storage-${config.apiPort}`);
  if (config.imgproxy !== false) dockerContainerNames.push(`supabase-imgproxy-${config.apiPort}`);
  if (config.mailpit !== false) dockerContainerNames.push(`supabase-mailpit-${config.apiPort}`);
  if (config.pgmeta !== false) dockerContainerNames.push(`supabase-pgmeta-${config.apiPort}`);
  if (config.studio !== false) dockerContainerNames.push(`supabase-studio-${config.apiPort}`);
  if (config.analytics !== false) dockerContainerNames.push(`supabase-analytics-${config.apiPort}`);
  if (config.vector !== false) dockerContainerNames.push(`supabase-vector-${config.apiPort}`);
  if (config.pooler !== false) dockerContainerNames.push(`supabase-pooler-${config.apiPort}`);
  return { dockerContainerNames };
}

export async function createStackController(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
): Promise<StackHandle> {
  const rawConfig = config ?? {};
  const portLease = await acquirePortLease(
    rawConfig.cacheRoot ?? defaultCacheRoot(),
    portInputForConfig(rawConfig),
  );
  let resolved: ResolvedStackConfig;
  try {
    resolved = await resolveConfig(rawConfig, { allocatedPorts: portLease.ports });
  } catch (error) {
    try {
      await portLease.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to resolve and clean up stack allocation",
      );
    }
    throw error;
  }
  const fullLayer = foregroundLayer(resolved, platformFactory);
  const runtime = ManagedRuntime.make(fullLayer);

  try {
    const services = await runtime.context();
    const localStack = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Stack;
      }),
    );
    const info = await runtime.runPromise(localStack.getInfo());

    const run = <A>(effect: Effect.Effect<A, unknown>) =>
      runtime.runPromise(effect).catch((error: unknown) => {
        throw toStackError(error);
      });

    let disposed = false;
    let disposeInFlight: Promise<void> | undefined;
    const gracefulDispose = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (disposeInFlight !== undefined) return disposeInFlight;
      const attempt = (async () => {
        // Run the retryable lifecycle cleanup before closing its Effect scope.
        // Once that succeeds, runtime disposal only releases layer resources.
        await run(localStack.dispose());
        await runtime.dispose().catch((error: unknown) => {
          throw toStackError(error);
        });
        await portLease.release();
        disposed = true;
      })();
      disposeInFlight = attempt.finally(() => {
        disposeInFlight = undefined;
      });
      return disposeInFlight;
    };

    const stack: StackHandle = {
      url: info.url,
      dbUrl: info.dbUrl,
      publishableKey: info.publishableKey,
      secretKey: info.secretKey,
      start: () => run(localStack.start()),
      stop: () => run(localStack.stop()),
      dispose: gracefulDispose,
      startService: (name) => run(localStack.startService(name)),
      stopService: (name) => run(localStack.stopService(name)),
      restartService: (name) => run(localStack.restartService(name)),
      ensureExtensionPreload: (name) => run(localStack.ensureExtensionPreload(name)),
      reloadFunctions: (opts) => run(localStack.reloadFunctions(opts)),
      reloadEdgeRuntime: (opts) => run(localStack.reloadEdgeRuntime(opts)),
      ready: (opts) => {
        const effect =
          opts?.timeout != null
            ? localStack.waitAllReady().pipe(Effect.timeout(Duration.millis(opts.timeout)))
            : localStack.waitAllReady();
        return run(effect);
      },
      serviceReady: (name, opts) => {
        const effect =
          opts?.timeout != null
            ? localStack.waitReady(name).pipe(Effect.timeout(Duration.millis(opts.timeout)))
            : localStack.waitReady(name);
        return run(effect);
      },
      getStatus: () => run(localStack.getAllStates()),
      getServiceStatus: (name) => run(localStack.getState(name)),
      statusChanges: () => Stream.toAsyncIterableWith(localStack.allStateChanges(), services),
      logs: () => Stream.toAsyncIterableWith(localStack.subscribeAllLogs(), services),
      serviceLogs: (name) => Stream.toAsyncIterableWith(localStack.subscribeLogs(name), services),
      logHistory: (name, limit) => run(localStack.logHistory(name, limit)),
      [Symbol.asyncDispose]: gracefulDispose,
    };

    return stack;
  } catch (error: unknown) {
    let cleanupError: unknown;
    await runtime.dispose().catch((cause: unknown) => {
      cleanupError = toStackError(cause);
    });
    dockerForceRemove(possibleCleanupTargetsForConfig(resolved).dockerContainerNames);
    cleanupAutoManagedPaths(resolved);
    if (cleanupError === undefined) {
      await portLease.release().catch((cause: unknown) => {
        cleanupError = cause;
      });
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [toStackError(error), cleanupError],
        "Failed to create and clean up stack",
      );
    }
    throw toStackError(error);
  }
}

/** Public constructor contract: resolve, start, and health-gate before returning. */
export async function createReadyStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
): Promise<StackHandle> {
  const stack = await createStackController(config, platformFactory);
  try {
    await stack.start();
    return stack;
  } catch (startError) {
    try {
      await stack.dispose();
    } catch (cleanupError) {
      throw new AggregateError([startError, cleanupError], "Failed to start and clean up stack");
    }
    throw startError;
  }
}

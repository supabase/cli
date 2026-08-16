import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { StackBuildError, toStackError } from "./errors.ts";
import { resolvedFunctionsBundleSchemaForProject } from "./functions.ts";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";
import {
  DEFAULT_MANAGED_STACK_NAME,
  defaultCacheRoot,
  defaultManagedProjectsRoot,
  defaultManagedRuntimeRoot,
  defaultManagedStackRoot,
  shortTempPrefixRoot,
} from "./paths.ts";
import {
  allocatePortSet,
  type PortReservationRequest,
  type PortAllocationError,
  type PortSelectionOptions,
} from "./PortAllocator.ts";
import {
  DEFAULT_PORTS,
  PORT_CATALOG,
  PORT_FIELDS,
  type PortField,
  type PortSet,
  type ResolvedPorts,
} from "./PortCatalog.ts";
import { portFieldsForConfigInput, serviceEnabledForConfig } from "./ServicePorts.ts";
import { StackMetadataSchema } from "./StackMetadata.ts";
import { INSTANCE_ID_PATTERN, InstanceIdSchema, resolveReadinessPolicy } from "./StackConfig.ts";
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
  ResolvedDaemonConfig,
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
} from "./StackConfig.ts";
import { DEFAULT_VERSIONS } from "./ServiceCatalog.ts";

const StackMetadataFileSchema = Schema.fromJsonString(StackMetadataSchema);
const decodeStackMetadataFile = Schema.decodeUnknownSync(StackMetadataFileSchema);

export function defaultManagedStackName(_cwd: string): string {
  return DEFAULT_MANAGED_STACK_NAME;
}

export interface ResolveConfigOptions {
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly preferredPorts?: PortSet;
  readonly reservedPorts?: ReadonlySet<number>;
  readonly portAllocator?: (
    requests: ReadonlyArray<PortReservationRequest>,
    options: PortSelectionOptions,
  ) => Effect.Effect<PortSet, PortAllocationError>;
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

const requiredPort = (ports: PortSet, field: PortField): number => {
  const port = ports[field];
  if (port === undefined) {
    throw new StackBuildError({
      detail: `Missing resolved port for active field ${field}`,
      reason: "invalid_config",
    });
  }
  return port;
};

async function readStackMetadataFile(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");
    return decodeStackMetadataFile(content);
  } catch {
    return undefined;
  }
}

async function readOwnedPorts(stackRoot: string): Promise<ResolvedPorts | undefined> {
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
            const port = ports[field];
            if (port !== undefined) reserved.add(port);
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
        const port = ports[field];
        if (port !== undefined) reserved.add(port);
      }
    }),
  );

  return reserved;
}

function resolvePostgrestConfig(
  input: PostgrestConfig | undefined,
  raw: PostgrestConfig | false | undefined,
  ports: PortSet,
): ResolvedPostgrestConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "postgrestPort"),
    adminPort: requiredPort(ports, "postgrestAdminPort"),
    schemas: cfg.schemas ?? ["public", "graphql_public"],
    extraSearchPath: cfg.extraSearchPath ?? ["public", "extensions"],
    maxRows: cfg.maxRows ?? 1000,
    version: cfg.version ?? DEFAULT_VERSIONS.postgrest,
  };
}

function resolveAuthConfig(
  input: AuthConfig | undefined,
  raw: AuthConfig | false | undefined,
  ports: PortSet,
  apiPort: number,
): ResolvedAuthConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "authPort"),
    siteUrl: cfg.siteUrl ?? "http://localhost:3000",
    jwtExpiry: cfg.jwtExpiry ?? 3600,
    externalUrl: cfg.externalUrl ?? `http://127.0.0.1:${apiPort}`,
    version: cfg.version ?? DEFAULT_VERSIONS.auth,
  };
}

function resolveRealtimeConfig(
  input: RealtimeConfig | undefined,
  raw: RealtimeConfig | false | undefined,
  ports: PortSet,
): ResolvedRealtimeConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "realtimePort"),
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
  raw: EdgeRuntimeConfig | false | undefined,
  ports: PortSet,
): ResolvedEdgeRuntimeConfig | false {
  if (raw === false || raw?.enabled === false) return false;
  const cfg = input ?? {};
  return {
    enabled: cfg.enabled ?? true,
    port: requiredPort(ports, "edgeRuntimePort"),
    inspectorPort: requiredPort(ports, "edgeRuntimeInspectorPort"),
    policy: cfg.policy ?? "per_worker",
    version: cfg.version ?? DEFAULT_VERSIONS["edge-runtime"],
    env: cfg.env ?? {},
  };
}

async function resolveFunctionsConfig(config: StackConfig, projectDir: string) {
  if (config.functions === undefined || config.functions === false) {
    return false;
  }
  try {
    return await Schema.decodeUnknownPromise(resolvedFunctionsBundleSchemaForProject(projectDir))(
      config.functions,
    );
  } catch (cause) {
    throw new StackBuildError({
      detail: "Invalid Edge Functions bundle",
      cause,
      reason: "invalid_config",
    });
  }
}

function resolveInstanceId(instanceId: string | undefined): string | undefined {
  if (instanceId === undefined) {
    return undefined;
  }
  try {
    return Schema.decodeUnknownSync(InstanceIdSchema)(instanceId);
  } catch (cause) {
    throw new StackBuildError({
      detail: `Invalid instanceId: must match ${INSTANCE_ID_PATTERN}`,
      cause,
      reason: "invalid_config",
    });
  }
}

function resolveStorageConfig(
  input: StorageConfig | undefined,
  raw: StorageConfig | false | undefined,
  ports: PortSet,
  opts: ResolveConfigOptions,
): ResolvedStorageConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "storagePort"),
    version: cfg.version ?? DEFAULT_VERSIONS.storage,
    dataDir: resolveDataDir(cfg.dataDir, opts.stackRoot!, "storage"),
    fileSizeLimit: cfg.fileSizeLimit ?? "50MiB",
    s3ProtocolEnabled: cfg.s3ProtocolEnabled ?? true,
  };
}

function resolveImgproxyConfig(
  input: ImgproxyConfig | undefined,
  raw: ImgproxyConfig | false | undefined,
  ports: PortSet,
): ResolvedImgproxyConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "imgproxyPort"),
    version: cfg.version ?? DEFAULT_VERSIONS.imgproxy,
  };
}

function resolveMailpitConfig(
  input: MailpitConfig | undefined,
  raw: MailpitConfig | false | undefined,
  ports: PortSet,
): ResolvedMailpitConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "mailpitPort"),
    smtpPort: requiredPort(ports, "mailpitSmtpPort"),
    pop3Port: requiredPort(ports, "mailpitPop3Port"),
    version: cfg.version ?? DEFAULT_VERSIONS.mailpit,
    adminEmail: cfg.adminEmail ?? "admin@email.com",
    senderName: cfg.senderName ?? "Admin",
  };
}

function resolvePgmetaConfig(
  input: PgmetaConfig | undefined,
  raw: PgmetaConfig | false | undefined,
  ports: PortSet,
): ResolvedPgmetaConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "pgmetaPort"),
    version: cfg.version ?? DEFAULT_VERSIONS.pgmeta,
  };
}

function resolveStudioConfig(
  input: StudioConfig | undefined,
  raw: StudioConfig | false | undefined,
  ports: PortSet,
  apiPort: number,
): ResolvedStudioConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "studioPort"),
    version: cfg.version ?? DEFAULT_VERSIONS.studio,
    apiUrl: cfg.apiUrl ?? `http://127.0.0.1:${apiPort}`,
  };
}

function resolveAnalyticsConfig(
  input: AnalyticsConfig | undefined,
  raw: AnalyticsConfig | false | undefined,
  ports: PortSet,
): ResolvedAnalyticsConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "analyticsPort"),
    version: cfg.version ?? DEFAULT_VERSIONS.analytics,
    backend: cfg.backend ?? "postgres",
    apiKey: cfg.apiKey ?? "api-key",
  };
}

function resolveVectorConfig(
  input: VectorConfig | undefined,
  raw: VectorConfig | false | undefined,
): ResolvedVectorConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    version: cfg.version ?? DEFAULT_VERSIONS.vector,
  };
}

function resolvePoolerConfig(
  input: PoolerConfig | undefined,
  raw: PoolerConfig | false | undefined,
  ports: PortSet,
): ResolvedPoolerConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: requiredPort(ports, "poolerPort"),
    apiPort: requiredPort(ports, "poolerApiPort"),
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

const enabledServiceConfig = <Config extends object>(
  enabled: boolean,
  config: Config | false | undefined,
): Config | undefined => (enabled && config !== false ? config : undefined);

export async function resolveConfig(
  input?: StackConfig,
  opts: ResolveConfigOptions = {},
): Promise<ResolvedStackConfig> {
  const config = input ?? {};
  const projectDir = config.projectDir ?? process.cwd();
  const instanceId = resolveInstanceId(config.instanceId);
  const functions = await resolveFunctionsConfig(config, projectDir);
  const resolvedMode = config.mode ?? "auto";
  const roots = resolveRoots(config, opts);
  const postgresInput = config.postgres ?? {};
  const postgrestInput = config.postgrest !== false ? (config.postgrest ?? undefined) : undefined;
  const authInput = config.auth !== false ? (config.auth ?? undefined) : undefined;
  const edgeRuntimeEnabled = serviceEnabledForConfig(config, "edge-runtime");
  const realtimeEnabled = serviceEnabledForConfig(config, "realtime");
  const storageEnabled = serviceEnabledForConfig(config, "storage");
  const imgproxyEnabled = serviceEnabledForConfig(config, "imgproxy");
  const mailpitEnabled = serviceEnabledForConfig(config, "mailpit");
  const pgmetaEnabled = serviceEnabledForConfig(config, "pgmeta");
  const studioEnabled = serviceEnabledForConfig(config, "studio");
  const analyticsEnabled = serviceEnabledForConfig(config, "analytics");
  const vectorEnabled = serviceEnabledForConfig(config, "vector");
  const poolerEnabled = serviceEnabledForConfig(config, "pooler");
  const edgeRuntimeInput = enabledServiceConfig(edgeRuntimeEnabled, config.edgeRuntime);
  const realtimeInput = enabledServiceConfig(realtimeEnabled, config.realtime);
  const storageInput = enabledServiceConfig(storageEnabled, config.storage);
  const imgproxyInput = enabledServiceConfig(imgproxyEnabled, config.imgproxy);
  const mailpitInput = enabledServiceConfig(mailpitEnabled, config.mailpit);
  const pgmetaInput = enabledServiceConfig(pgmetaEnabled, config.pgmeta);
  const studioInput = enabledServiceConfig(studioEnabled, config.studio);
  const analyticsInput = enabledServiceConfig(analyticsEnabled, config.analytics);
  const vectorInput = enabledServiceConfig(vectorEnabled, config.vector);
  const poolerInput = enabledServiceConfig(poolerEnabled, config.pooler);

  const postgresDataDir = resolveDataDir(postgresInput.dataDir, roots.stackRoot, "postgres");

  const explicitPortForField = (field: PortField): number | undefined => {
    switch (field) {
      case "apiPort":
        return config.port;
      case "dbPort":
        return postgresInput.port;
      case "authPort":
        return authInput?.port;
      case "edgeRuntimePort":
        return edgeRuntimeInput?.port;
      case "edgeRuntimeInspectorPort":
        return edgeRuntimeInput?.inspectorPort;
      case "realtimePort":
        return realtimeInput?.port;
      case "storagePort":
        return storageInput?.port;
      case "imgproxyPort":
        return imgproxyInput?.port;
      case "mailpitPort":
        return mailpitInput?.port;
      case "mailpitSmtpPort":
        return mailpitInput?.smtpPort;
      case "mailpitPop3Port":
        return mailpitInput?.pop3Port;
      case "pgmetaPort":
        return pgmetaInput?.port;
      case "studioPort":
        return studioInput?.port;
      case "analyticsPort":
        return analyticsInput?.port;
      case "poolerPort":
        return poolerInput?.port;
      case "poolerApiPort":
        return poolerInput?.apiPort;
      case "postgrestPort":
      case "postgrestAdminPort":
        return undefined;
    }
  };

  const unorderedRequests: ReadonlyArray<PortReservationRequest> = portFieldsForConfigInput(
    config,
  ).map((field) => {
    const explicit = explicitPortForField(field);
    if (explicit !== undefined) {
      return { field, selection: { kind: "exact", port: explicit } };
    }
    const preferred = opts.preferredPorts?.[field] ?? PORT_CATALOG[field].preferred;
    return preferred === undefined
      ? { field, selection: { kind: "automatic" } }
      : { field, selection: { kind: "automatic", preferred } };
  });
  const requests: ReadonlyArray<PortReservationRequest> = [
    ...unorderedRequests.filter((request) => request.selection.kind === "exact"),
    ...unorderedRequests.filter((request) => request.selection.kind === "automatic"),
  ];

  const ports = await Effect.runPromise(
    (opts.portAllocator ?? allocatePortSet)(requests, { reserved: opts.reservedPorts }),
  ).catch((error: unknown) => {
    throw toStackError(error);
  });

  const jwtSecret = config.jwtSecret ?? defaultJwtSecret;
  const anonJwt = generateJwt(jwtSecret, "anon");
  const serviceRoleJwt = generateJwt(jwtSecret, "service_role");
  const apiPort = requiredPort(ports, "apiPort");
  const dbPort = requiredPort(ports, "dbPort");
  const resolvedPorts: ResolvedPorts = { ...ports, apiPort, dbPort };

  return {
    instanceId,
    cacheRoot: roots.cacheRoot,
    stackRoot: roots.stackRoot,
    runtimeRoot: roots.runtimeRoot,
    projectDir,
    mode: resolvedMode,
    startupMode: config.startupMode ?? "eager",
    readiness: resolveReadinessPolicy({ stackPolicy: config.readiness }),
    readinessSource: config.readiness === undefined ? "default" : "configured",
    jwtSecret,
    ports: resolvedPorts,
    apiPort,
    dbPort,
    publishableKey: config.publishableKey ?? defaultPublishableKey,
    secretKey: config.secretKey ?? defaultSecretKey,
    functions,
    autoManagedPaths: roots.autoManagedPaths,
    anonJwt,
    serviceRoleJwt,
    postgres: {
      port: dbPort,
      dataDir: postgresDataDir,
      version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
      autoExposeNewTables: postgresInput.autoExposeNewTables ?? true,
    },
    postgrest: resolvePostgrestConfig(postgrestInput, config.postgrest, ports),
    auth: resolveAuthConfig(authInput, config.auth, ports, apiPort),
    edgeRuntime: edgeRuntimeEnabled
      ? resolveEdgeRuntimeConfig(edgeRuntimeInput, config.edgeRuntime, ports)
      : false,
    realtime: realtimeEnabled
      ? resolveRealtimeConfig(realtimeInput, config.realtime, ports)
      : false,
    storage: storageEnabled
      ? resolveStorageConfig(storageInput, config.storage, ports, {
          ...opts,
          stackRoot: roots.stackRoot,
        })
      : false,
    imgproxy: imgproxyEnabled
      ? resolveImgproxyConfig(imgproxyInput, config.imgproxy, ports)
      : false,
    mailpit: mailpitEnabled ? resolveMailpitConfig(mailpitInput, config.mailpit, ports) : false,
    pgmeta: pgmetaEnabled ? resolvePgmetaConfig(pgmetaInput, config.pgmeta, ports) : false,
    studio: studioEnabled ? resolveStudioConfig(studioInput, config.studio, ports, apiPort) : false,
    analytics: analyticsEnabled
      ? resolveAnalyticsConfig(analyticsInput, config.analytics, ports)
      : false,
    vector: vectorEnabled ? resolveVectorConfig(vectorInput, config.vector) : false,
    pooler: poolerEnabled ? resolvePoolerConfig(poolerInput, config.pooler, ports) : false,
  };
}

export type DaemonConfigInput = Omit<StackConfig, "functions"> & {
  readonly cwd: string;
  readonly name?: string;
  readonly projectDir?: string;
  readonly projectStateRoot?: string;
};

export function sanitizeDaemonConfigInput(
  input: DaemonConfigInput & { readonly functions?: unknown },
): DaemonConfigInput {
  const { functions: _functions, ...config } = input;
  return config;
}

export async function resolveDaemonConfig(
  input: DaemonConfigInput,
  opts: Pick<ResolveConfigOptions, "portAllocator"> = {},
): Promise<ResolvedDaemonConfig> {
  const { cwd, name, projectDir, projectStateRoot, ...stackConfig } =
    sanitizeDaemonConfigInput(input);
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
      portAllocator: opts.portAllocator,
    },
  );
  return {
    ...resolved,
    name: resolvedName,
    projectDir: effectiveProjectDir,
  };
}

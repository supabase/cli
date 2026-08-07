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
  allocatePorts,
  DEFAULT_PORTS,
  PORT_FIELDS,
  type AllocatedPorts,
  type PortAllocationError,
  type PortInput,
  type PortSelectionOptions,
} from "./PortAllocator.ts";
import { StackMetadataSchema } from "./StackMetadata.ts";
import { resolveReadinessPolicy } from "./StackConfig.ts";
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
  readonly preferredPorts?: Partial<AllocatedPorts>;
  readonly reservedPorts?: ReadonlySet<number>;
  readonly portAllocator?: (
    input: PortInput,
    options: PortSelectionOptions,
  ) => Effect.Effect<AllocatedPorts, PortAllocationError>;
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
  raw: PostgrestConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedPostgrestConfig | false {
  if (raw === false) return false;
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

function resolveRealtimeConfig(
  input: RealtimeConfig | undefined,
  raw: RealtimeConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedRealtimeConfig | false {
  if (raw === false) return false;
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
  raw: EdgeRuntimeConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedEdgeRuntimeConfig | false {
  if (raw === false || raw?.enabled === false) return false;
  const cfg = input ?? {};
  return {
    enabled: cfg.enabled ?? true,
    port: ports.edgeRuntimePort,
    inspectorPort: ports.edgeRuntimeInspectorPort,
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
    throw new StackBuildError({ detail: "Invalid Edge Functions bundle", cause });
  }
}

function resolveStorageConfig(
  input: StorageConfig | undefined,
  raw: StorageConfig | false | undefined,
  ports: AllocatedPorts,
  opts: ResolveConfigOptions,
): ResolvedStorageConfig | false {
  if (raw === false) return false;
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
  raw: ImgproxyConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedImgproxyConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: ports.imgproxyPort,
    version: cfg.version ?? DEFAULT_VERSIONS.imgproxy,
  };
}

function resolveMailpitConfig(
  input: MailpitConfig | undefined,
  raw: MailpitConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedMailpitConfig | false {
  if (raw === false) return false;
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
  raw: PgmetaConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedPgmetaConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: ports.pgmetaPort,
    version: cfg.version ?? DEFAULT_VERSIONS.pgmeta,
  };
}

function resolveStudioConfig(
  input: StudioConfig | undefined,
  raw: StudioConfig | false | undefined,
  ports: AllocatedPorts,
  apiPort: number,
): ResolvedStudioConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: ports.studioPort,
    version: cfg.version ?? DEFAULT_VERSIONS.studio,
    apiUrl: cfg.apiUrl ?? `http://127.0.0.1:${apiPort}`,
  };
}

function resolveAnalyticsConfig(
  input: AnalyticsConfig | undefined,
  raw: AnalyticsConfig | false | undefined,
  ports: AllocatedPorts,
): ResolvedAnalyticsConfig | false {
  if (raw === false) return false;
  const cfg = input ?? {};
  return {
    port: ports.analyticsPort,
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
  ports: AllocatedPorts,
): ResolvedPoolerConfig | false {
  if (raw === false) return false;
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
  const functions = await resolveFunctionsConfig(config, projectDir);
  const resolvedMode = config.mode ?? "auto";
  const roots = resolveRoots(config, opts);
  const postgresInput = config.postgres ?? {};
  const postgrestInput = config.postgrest !== false ? (config.postgrest ?? undefined) : undefined;
  const authInput = config.auth !== false ? (config.auth ?? undefined) : undefined;
  const edgeRuntimeEnabled =
    !(resolvedMode === "native" && config.edgeRuntime === undefined) &&
    config.edgeRuntime !== false &&
    (config.edgeRuntime?.enabled ?? true) !== false;
  const realtimeEnabled = config.realtime !== undefined && config.realtime !== false;
  const storageEnabled = config.storage !== undefined && config.storage !== false;
  const imgproxyEnabled = config.imgproxy !== undefined && config.imgproxy !== false;
  const mailpitEnabled = config.mailpit !== undefined && config.mailpit !== false;
  const pgmetaEnabled = config.pgmeta !== undefined && config.pgmeta !== false;
  const studioEnabled = config.studio !== undefined && config.studio !== false;
  const analyticsEnabled = config.analytics !== undefined && config.analytics !== false;
  const vectorEnabled = config.vector !== undefined && config.vector !== false;
  const poolerEnabled = config.pooler !== undefined && config.pooler !== false;
  const edgeRuntimeInput = edgeRuntimeEnabled ? (config.edgeRuntime ?? undefined) : undefined;
  const realtimeInput = realtimeEnabled ? (config.realtime ?? undefined) : undefined;
  const storageInput = storageEnabled ? (config.storage ?? undefined) : undefined;
  const imgproxyInput = imgproxyEnabled ? (config.imgproxy ?? undefined) : undefined;
  const mailpitInput = mailpitEnabled ? (config.mailpit ?? undefined) : undefined;
  const pgmetaInput = pgmetaEnabled ? (config.pgmeta ?? undefined) : undefined;
  const studioInput = studioEnabled ? (config.studio ?? undefined) : undefined;
  const analyticsInput = analyticsEnabled ? (config.analytics ?? undefined) : undefined;
  const vectorInput = vectorEnabled ? (config.vector ?? undefined) : undefined;
  const poolerInput = poolerEnabled ? (config.pooler ?? undefined) : undefined;

  const postgresDataDir = resolveDataDir(postgresInput.dataDir, roots.stackRoot, "postgres");

  const ports = await Effect.runPromise(
    (opts.portAllocator ?? allocatePorts)(
      {
        apiPort: config.port,
        dbPort: postgresInput.port,
        authPort: authInput?.port,
        postgrestPort: undefined,
        postgrestAdminPort: undefined,
        edgeRuntimePort: edgeRuntimeInput?.port,
        edgeRuntimeInspectorPort: edgeRuntimeInput?.inspectorPort,
        realtimePort: realtimeInput?.port,
        storagePort: storageInput?.port,
        imgproxyPort: imgproxyInput?.port,
        mailpitPort: mailpitInput?.port,
        mailpitSmtpPort: mailpitInput?.smtpPort,
        mailpitPop3Port: mailpitInput?.pop3Port,
        pgmetaPort: pgmetaInput?.port,
        studioPort: studioInput?.port,
        analyticsPort: analyticsInput?.port,
        poolerPort: poolerInput?.port,
        poolerApiPort: poolerInput?.apiPort,
      },
      {
        preferred: opts.preferredPorts,
        reserved: opts.reservedPorts,
      },
    ),
  ).catch((error: unknown) => {
    throw toStackError(error);
  });

  const jwtSecret = config.jwtSecret ?? defaultJwtSecret;
  const anonJwt = generateJwt(jwtSecret, "anon");
  const serviceRoleJwt = generateJwt(jwtSecret, "service_role");

  return {
    cacheRoot: roots.cacheRoot,
    stackRoot: roots.stackRoot,
    runtimeRoot: roots.runtimeRoot,
    projectDir,
    mode: resolvedMode,
    startupMode: config.startupMode ?? "eager",
    readiness: resolveReadinessPolicy({ stackPolicy: config.readiness }),
    readinessSource: config.readiness === undefined ? "default" : "configured",
    jwtSecret,
    ports,
    apiPort: ports.apiPort,
    dbPort: ports.dbPort,
    publishableKey: config.publishableKey ?? defaultPublishableKey,
    secretKey: config.secretKey ?? defaultSecretKey,
    functions,
    autoManagedPaths: roots.autoManagedPaths,
    anonJwt,
    serviceRoleJwt,
    postgres: {
      port: ports.dbPort,
      dataDir: postgresDataDir,
      version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
      autoExposeNewTables: postgresInput.autoExposeNewTables ?? true,
    },
    postgrest: resolvePostgrestConfig(postgrestInput, config.postgrest, ports),
    auth: resolveAuthConfig(authInput, config.auth, ports, ports.apiPort),
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
    studio: studioEnabled
      ? resolveStudioConfig(studioInput, config.studio, ports, ports.apiPort)
      : false,
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

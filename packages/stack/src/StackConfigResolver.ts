import { join } from "node:path";
import { Effect, Exit, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { StackBuildError } from "./errors.ts";
import { resolvedFunctionsBundleSchemaForProject } from "./functions.ts";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";
import { defaultCacheRoot, shortTempPrefixRoot } from "./paths.ts";
import { type PortReservationRequest } from "./PortAllocator.ts";
import { PORT_CATALOG, type PortField, type PortSet, type ResolvedPorts } from "./PortCatalog.ts";
import { portFieldsForConfigInput, serviceEnabledForConfig } from "./ServicePorts.ts";
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

export interface ResolveConfigOptions {
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly preferredPorts?: PortSet;
  /** Ports selected by the owning caller's authoritative lease. */
  readonly ports?: PortSet;
  readonly disablePreferredPorts?: ReadonlySet<PortField>;
}

interface ResolvedRoots {
  readonly cacheRoot: string;
  readonly stackRoot: string;
  readonly runtimeRoot: string;
  readonly autoManagedPaths: ReadonlyArray<string>;
}

const cleanupRoots = (
  paths: ReadonlyArray<string>,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forEach(
        paths,
        (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.ignoreCause),
        { discard: true },
      );
    }),
  );

const tempRootError = (prefix: string, cause: PlatformError): StackBuildError =>
  new StackBuildError({ detail: `Failed to create temporary ${prefix} directory`, cause });

const makeTempRoot = (
  prefix: string,
): Effect.Effect<string, StackBuildError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .makeTempDirectory({ directory: shortTempPrefixRoot(), prefix })
      .pipe(Effect.mapError((cause) => tempRootError(prefix, cause)));
  });

const resolveRoots = (
  config: StackConfig,
  opts: ResolveConfigOptions,
): Effect.Effect<ResolvedRoots, StackBuildError, FileSystem.FileSystem> =>
  Effect.suspend(() => {
    const autoManagedPaths: string[] = [];
    return Effect.gen(function* () {
      const cacheRoot = config.cacheRoot ?? defaultCacheRoot();
      const makeTrackedTempRoot = (prefix: string) =>
        Effect.uninterruptibleMask((restore) =>
          restore(makeTempRoot(prefix)).pipe(
            Effect.tap((dir) => Effect.sync(() => autoManagedPaths.push(dir))),
          ),
        );
      const stackRoot =
        opts.stackRoot ?? config.stackRoot ?? (yield* makeTrackedTempRoot("sb-stack-"));
      const runtimeRoot =
        opts.runtimeRoot ?? config.runtimeRoot ?? (yield* makeTrackedTempRoot("sb-run-"));
      return { cacheRoot, stackRoot, runtimeRoot, autoManagedPaths };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : cleanupRoots(autoManagedPaths),
      ),
    );
  });

const resolveDataDir = (
  explicitDir: string | undefined,
  stackRoot: string,
  suffix: string,
): string => explicitDir ?? join(stackRoot, "data", suffix);

const requiredPort = (ports: PortSet, field: PortField): Effect.Effect<number, StackBuildError> => {
  const port = ports[field];
  if (port === undefined) {
    return Effect.fail(
      new StackBuildError({
        detail: `Missing resolved port for active field ${field}`,
        reason: "invalid_config",
      }),
    );
  }
  return Effect.succeed(port);
};

function resolvePostgrestConfig(
  input: PostgrestConfig | undefined,
  raw: PostgrestConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedPostgrestConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return Effect.all({
    port: requiredPort(ports, "postgrestPort"),
    adminPort: requiredPort(ports, "postgrestAdminPort"),
  }).pipe(
    Effect.map(({ port, adminPort }) => ({
      port,
      adminPort,
      schemas: cfg.schemas ?? ["public", "graphql_public"],
      extraSearchPath: cfg.extraSearchPath ?? ["public", "extensions"],
      maxRows: cfg.maxRows ?? 1000,
      version: cfg.version ?? DEFAULT_VERSIONS.postgrest,
    })),
  );
}

function resolveAuthConfig(
  input: AuthConfig | undefined,
  raw: AuthConfig | false | undefined,
  ports: PortSet,
  apiPort: number,
): Effect.Effect<ResolvedAuthConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "authPort").pipe(
    Effect.map((port) => ({
      port,
      siteUrl: cfg.siteUrl ?? "http://localhost:3000",
      jwtExpiry: cfg.jwtExpiry ?? 3600,
      externalUrl: cfg.externalUrl ?? `http://127.0.0.1:${apiPort}`,
      version: cfg.version ?? DEFAULT_VERSIONS.auth,
    })),
  );
}

function resolveRealtimeConfig(
  input: RealtimeConfig | undefined,
  raw: RealtimeConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedRealtimeConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "realtimePort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.realtime,
      tenantId: cfg.tenantId ?? "realtime-dev",
      encryptionKey: cfg.encryptionKey ?? "supabaserealtime",
      secretKeyBase:
        cfg.secretKeyBase ?? "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
      maxHeaderLength: cfg.maxHeaderLength ?? 4096,
    })),
  );
}

function resolveEdgeRuntimeConfig(
  input: EdgeRuntimeConfig | undefined,
  raw: EdgeRuntimeConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedEdgeRuntimeConfig | false, StackBuildError> {
  if (raw === false || raw?.enabled === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return Effect.all({
    port: requiredPort(ports, "edgeRuntimePort"),
    inspectorPort: requiredPort(ports, "edgeRuntimeInspectorPort"),
  }).pipe(
    Effect.map(({ port, inspectorPort }) => ({
      enabled: cfg.enabled ?? true,
      port,
      inspectorPort,
      policy: cfg.policy ?? "per_worker",
      version: cfg.version ?? DEFAULT_VERSIONS["edge-runtime"],
      env: cfg.env ?? {},
    })),
  );
}

const resolveFunctionsConfig = (
  config: StackConfig,
  projectDir: string,
): Effect.Effect<false | NonNullable<ResolvedStackConfig["functions"]>, StackBuildError> => {
  if (config.functions === undefined || config.functions === false) {
    return Effect.succeed(false);
  }
  return Schema.decodeUnknownEffect(resolvedFunctionsBundleSchemaForProject(projectDir))(
    config.functions,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new StackBuildError({
          detail: "Invalid Edge Functions bundle",
          cause,
          reason: "invalid_config",
        }),
    ),
  );
};

const resolveInstanceId = (
  instanceId: string | undefined,
): Effect.Effect<string | undefined, StackBuildError> => {
  if (instanceId === undefined) {
    return Effect.succeed(undefined);
  }
  return Schema.decodeUnknownEffect(InstanceIdSchema)(instanceId).pipe(
    Effect.mapError(
      (cause) =>
        new StackBuildError({
          detail: `Invalid instanceId: must match ${INSTANCE_ID_PATTERN}`,
          cause,
          reason: "invalid_config",
        }),
    ),
  );
};

function resolveStorageConfig(
  input: StorageConfig | undefined,
  raw: StorageConfig | false | undefined,
  ports: PortSet,
  stackRoot: string,
): Effect.Effect<ResolvedStorageConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "storagePort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.storage,
      dataDir: resolveDataDir(cfg.dataDir, stackRoot, "storage"),
      fileSizeLimit: cfg.fileSizeLimit ?? "50MiB",
      s3ProtocolEnabled: cfg.s3ProtocolEnabled ?? true,
    })),
  );
}

function resolveImgproxyConfig(
  input: ImgproxyConfig | undefined,
  raw: ImgproxyConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedImgproxyConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "imgproxyPort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.imgproxy,
    })),
  );
}

function resolveMailpitConfig(
  input: MailpitConfig | undefined,
  raw: MailpitConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedMailpitConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return Effect.all({
    port: requiredPort(ports, "mailpitPort"),
    smtpPort: requiredPort(ports, "mailpitSmtpPort"),
    pop3Port: requiredPort(ports, "mailpitPop3Port"),
  }).pipe(
    Effect.map(({ port, smtpPort, pop3Port }) => ({
      port,
      smtpPort,
      pop3Port,
      version: cfg.version ?? DEFAULT_VERSIONS.mailpit,
      adminEmail: cfg.adminEmail ?? "admin@email.com",
      senderName: cfg.senderName ?? "Admin",
    })),
  );
}

function resolvePgmetaConfig(
  input: PgmetaConfig | undefined,
  raw: PgmetaConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedPgmetaConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "pgmetaPort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.pgmeta,
    })),
  );
}

function resolveStudioConfig(
  input: StudioConfig | undefined,
  raw: StudioConfig | false | undefined,
  ports: PortSet,
  apiPort: number,
): Effect.Effect<ResolvedStudioConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "studioPort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.studio,
      apiUrl: cfg.apiUrl ?? `http://127.0.0.1:${apiPort}`,
    })),
  );
}

function resolveAnalyticsConfig(
  input: AnalyticsConfig | undefined,
  raw: AnalyticsConfig | false | undefined,
  ports: PortSet,
): Effect.Effect<ResolvedAnalyticsConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "analyticsPort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.analytics,
      backend: cfg.backend ?? "postgres",
      apiKey: cfg.apiKey ?? "api-key",
    })),
  );
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
): Effect.Effect<ResolvedPoolerConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return Effect.all({
    port: requiredPort(ports, "poolerPort"),
    apiPort: requiredPort(ports, "poolerApiPort"),
  }).pipe(
    Effect.map(({ port, apiPort }) => ({
      port,
      apiPort,
      mode: cfg.mode ?? "transaction",
      version: cfg.version ?? DEFAULT_VERSIONS.pooler,
      tenantId: cfg.tenantId ?? "pooler-dev",
      encryptionKey: cfg.encryptionKey ?? "12345678901234567890123456789032",
      secretKeyBase:
        cfg.secretKeyBase ?? "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
      defaultPoolSize: cfg.defaultPoolSize ?? 20,
      maxClientConn: cfg.maxClientConn ?? 100,
    })),
  );
}

const enabledServiceConfig = <Config extends object>(
  enabled: boolean,
  config: Config | false | undefined,
): Config | undefined => (enabled && config !== false ? config : undefined);

const invalidPort = (field: PortField, port: number): StackBuildError =>
  new StackBuildError({
    detail: `Invalid port for ${field}: expected an integer between 1 and 65535`,
    reason: "invalid_config",
    cause: port,
  });

/** Validate explicit/preferred intents before any filesystem or socket mutation. */
const validatePortRequests = (
  requests: ReadonlyArray<PortReservationRequest>,
): Effect.Effect<void, StackBuildError> =>
  Effect.forEach(
    requests,
    (request) => {
      const port =
        request.selection.kind === "exact" ? request.selection.port : request.selection.preferred;
      return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65_535)
        ? Effect.void
        : Effect.fail(invalidPort(request.field, port));
    },
    { discard: true },
  );

const validateAuthoritativePorts = (
  requests: ReadonlyArray<PortReservationRequest>,
  ports: PortSet,
): Effect.Effect<void, StackBuildError> =>
  Effect.forEach(
    requests,
    (request) => {
      const selected = ports[request.field];
      if (selected === undefined) {
        return Effect.fail(
          new StackBuildError({
            detail: `Missing resolved port for active field ${request.field}`,
            reason: "invalid_config",
          }),
        );
      }
      if (!Number.isInteger(selected) || selected < 1 || selected > 65_535) {
        return Effect.fail(invalidPort(request.field, selected));
      }
      if (request.selection.kind === "exact" && selected !== request.selection.port) {
        return Effect.fail(
          new StackBuildError({
            detail: `Authoritative lease changed explicit port for ${request.field}`,
            reason: "invalid_config",
          }),
        );
      }
      return Effect.void;
    },
    { discard: true },
  );

export const resolveConfig = (
  input?: StackConfig,
  opts: ResolveConfigOptions = {},
): Effect.Effect<ResolvedStackConfig, StackBuildError, FileSystem.FileSystem> =>
  Effect.suspend(() => {
    let roots: ResolvedRoots | undefined;
    return Effect.gen(function* () {
      const config = input ?? {};
      const requests = yield* portRequestsForConfig(config, opts);
      const ports = opts.ports;
      if (ports === undefined) {
        return yield* Effect.fail(
          new StackBuildError({
            detail: "Config resolution requires an authoritative port lease",
            reason: "invalid_config",
          }),
        );
      }
      yield* validateAuthoritativePorts(requests, ports);
      const projectDir = config.projectDir ?? process.cwd();
      const instanceId = yield* resolveInstanceId(config.instanceId);
      const functions = yield* resolveFunctionsConfig(config, projectDir);
      const resolvedMode = config.mode ?? "auto";
      const resolvedRoots = yield* resolveRoots(config, opts);
      roots = resolvedRoots;
      const postgresInput = config.postgres ?? {};
      const postgrestInput =
        config.postgrest !== false ? (config.postgrest ?? undefined) : undefined;
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

      const postgresDataDir = resolveDataDir(
        postgresInput.dataDir,
        resolvedRoots.stackRoot,
        "postgres",
      );

      const jwtSecret = config.jwtSecret ?? defaultJwtSecret;
      const anonJwt = generateJwt(jwtSecret, "anon");
      const serviceRoleJwt = generateJwt(jwtSecret, "service_role");
      const apiPort = yield* requiredPort(ports, "apiPort");
      const dbPort = yield* requiredPort(ports, "dbPort");
      const resolvedPorts: ResolvedPorts = { ...ports, apiPort, dbPort };

      return {
        instanceId,
        cacheRoot: resolvedRoots.cacheRoot,
        stackRoot: resolvedRoots.stackRoot,
        runtimeRoot: resolvedRoots.runtimeRoot,
        projectDir,
        mode: resolvedMode,
        startupMode: config.startupMode ?? "eager",
        readiness: resolveReadinessPolicy({ stackPolicy: config.readiness }),
        readinessSource:
          config.readiness === undefined ? ("default" as const) : ("configured" as const),
        jwtSecret,
        ports: resolvedPorts,
        apiPort,
        dbPort,
        publishableKey: config.publishableKey ?? defaultPublishableKey,
        secretKey: config.secretKey ?? defaultSecretKey,
        functions,
        autoManagedPaths: resolvedRoots.autoManagedPaths,
        anonJwt,
        serviceRoleJwt,
        postgres: {
          port: dbPort,
          dataDir: postgresDataDir,
          version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
          autoExposeNewTables: postgresInput.autoExposeNewTables ?? true,
        },
        postgrest: yield* resolvePostgrestConfig(postgrestInput, config.postgrest, ports),
        auth: yield* resolveAuthConfig(authInput, config.auth, ports, apiPort),
        edgeRuntime: edgeRuntimeEnabled
          ? yield* resolveEdgeRuntimeConfig(edgeRuntimeInput, config.edgeRuntime, ports)
          : false,
        realtime: realtimeEnabled
          ? yield* resolveRealtimeConfig(realtimeInput, config.realtime, ports)
          : false,
        storage: storageEnabled
          ? yield* resolveStorageConfig(
              storageInput,
              config.storage,
              ports,
              resolvedRoots.stackRoot,
            )
          : false,
        imgproxy: imgproxyEnabled
          ? yield* resolveImgproxyConfig(imgproxyInput, config.imgproxy, ports)
          : false,
        mailpit: mailpitEnabled
          ? yield* resolveMailpitConfig(mailpitInput, config.mailpit, ports)
          : false,
        pgmeta: pgmetaEnabled
          ? yield* resolvePgmetaConfig(pgmetaInput, config.pgmeta, ports)
          : false,
        studio: studioEnabled
          ? yield* resolveStudioConfig(studioInput, config.studio, ports, apiPort)
          : false,
        analytics: analyticsEnabled
          ? yield* resolveAnalyticsConfig(analyticsInput, config.analytics, ports)
          : false,
        vector: vectorEnabled ? resolveVectorConfig(vectorInput, config.vector) : false,
        pooler: poolerEnabled
          ? yield* resolvePoolerConfig(poolerInput, config.pooler, ports)
          : false,
      };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || roots === undefined
          ? Effect.void
          : cleanupRoots(roots.autoManagedPaths),
      ),
    );
  });

/** Return the active port intents without binding or probing any socket. */
const buildPortRequestsForConfig = (
  config: StackConfig = {},
  opts: Pick<ResolveConfigOptions, "preferredPorts" | "disablePreferredPorts"> = {},
): ReadonlyArray<PortReservationRequest> => {
  const explicitPortForField = (field: PortField): number | undefined => {
    const postgres = config.postgres ?? {};
    const auth = config.auth !== false ? (config.auth ?? undefined) : undefined;
    const edgeRuntime =
      config.edgeRuntime !== false ? (config.edgeRuntime ?? undefined) : undefined;
    const realtime = config.realtime !== false ? (config.realtime ?? undefined) : undefined;
    const storage = config.storage !== false ? (config.storage ?? undefined) : undefined;
    const imgproxy = config.imgproxy !== false ? (config.imgproxy ?? undefined) : undefined;
    const mailpit = config.mailpit !== false ? (config.mailpit ?? undefined) : undefined;
    const pgmeta = config.pgmeta !== false ? (config.pgmeta ?? undefined) : undefined;
    const studio = config.studio !== false ? (config.studio ?? undefined) : undefined;
    const analytics = config.analytics !== false ? (config.analytics ?? undefined) : undefined;
    const pooler = config.pooler !== false ? (config.pooler ?? undefined) : undefined;
    switch (field) {
      case "apiPort":
        return config.port;
      case "dbPort":
        return postgres.port;
      case "authPort":
        return auth?.port;
      case "edgeRuntimePort":
        return edgeRuntime?.port;
      case "edgeRuntimeInspectorPort":
        return edgeRuntime?.inspectorPort;
      case "realtimePort":
        return realtime?.port;
      case "storagePort":
        return storage?.port;
      case "imgproxyPort":
        return imgproxy?.port;
      case "mailpitPort":
        return mailpit?.port;
      case "mailpitSmtpPort":
        return mailpit?.smtpPort;
      case "mailpitPop3Port":
        return mailpit?.pop3Port;
      case "pgmetaPort":
        return pgmeta?.port;
      case "studioPort":
        return studio?.port;
      case "analyticsPort":
        return analytics?.port;
      case "poolerPort":
        return pooler?.port;
      case "poolerApiPort":
        return pooler?.apiPort;
      case "postgrestPort":
      case "postgrestAdminPort":
        return undefined;
    }
  };
  const unordered = portFieldsForConfigInput(config).map((field) => {
    const explicit = explicitPortForField(field);
    if (explicit !== undefined)
      return { field, selection: { kind: "exact", port: explicit } } as const;
    const preferred = opts.disablePreferredPorts?.has(field)
      ? undefined
      : (opts.preferredPorts?.[field] ?? PORT_CATALOG[field].preferred);
    return preferred === undefined
      ? ({ field, selection: { kind: "automatic" } } as const)
      : ({ field, selection: { kind: "automatic", preferred } } as const);
  });
  return [
    ...unordered.filter((request) => request.selection.kind === "exact"),
    ...unordered.filter((request) => request.selection.kind === "automatic"),
  ];
};

/** Plan active ports and validate all user-supplied values before mutation. */
export const portRequestsForConfig = (
  config: StackConfig = {},
  opts: Pick<ResolveConfigOptions, "preferredPorts" | "disablePreferredPorts"> = {},
): Effect.Effect<ReadonlyArray<PortReservationRequest>, StackBuildError> =>
  Effect.suspend(() => {
    const requests = buildPortRequestsForConfig(config, opts);
    return validatePortRequests(requests).pipe(Effect.as(requests));
  });

export type DaemonConfigInput = Omit<StackConfig, "functions"> & {
  readonly cwd: string;
  readonly name?: string;
  readonly projectDir?: string;
};

export function sanitizeDaemonConfigInput(
  input: DaemonConfigInput & { readonly functions?: unknown },
): DaemonConfigInput {
  const { functions: _functions, ...config } = input;
  return config;
}

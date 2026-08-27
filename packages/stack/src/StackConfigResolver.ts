import { join } from "node:path";
import { Effect, Exit, FileSystem, Record, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { StackBuildError } from "./errors.ts";
import {
  resolvedFunctionsBundleSchemaForProject,
  type ResolvedFunctionsBundle,
} from "./functions.ts";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";
import { defaultCacheRoot, shortTempPrefixRoot } from "./paths.ts";
import { type PortReservationRequest } from "./PortAllocator.ts";
import { PORT_CATALOG, type PortField, type PortSet, type ResolvedPorts } from "./PortCatalog.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
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
  ServicePolicy,
  ServicePolicyManifest,
  StackConfig,
  StorageConfig,
  StudioConfig,
  VectorConfig,
} from "./StackConfig.ts";
import type { StackRuntimeSelection } from "./ContainerRuntime.ts";
import {
  DEFAULT_SERVICE_POLICIES,
  DEFAULT_VERSIONS,
  SERVICE_CATALOG,
  SERVICE_NAMES,
  serviceMetadata,
} from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

export interface ResolveConfigOptions {
  /** Ports selected by the caller-owned lease. Resolution never allocates ports. */
  readonly ports: PortSet;
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly runtime?: StackRuntimeSelection;
}

interface ResolvedRoots {
  readonly cacheRoot: string;
  readonly stackRoot: string;
  readonly runtimeRoot: string;
  readonly autoManagedPaths: ReadonlyArray<string>;
}

const cleanupAutoManagedPaths = (
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
  new StackBuildError({
    detail: `Failed to create temporary ${prefix} directory`,
    cause,
  });

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
  Effect.gen(function* () {
    const cacheRoot = config.cacheRoot ?? defaultCacheRoot();
    const autoManagedPaths: string[] = [];
    const roots = yield* Effect.gen(function* () {
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

      return {
        cacheRoot,
        stackRoot,
        runtimeRoot,
        autoManagedPaths,
      };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : cleanupAutoManagedPaths(autoManagedPaths),
      ),
    );
    return roots;
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

function resolveFunctionsConfig(
  config: StackConfig,
  projectDir: string,
): Effect.Effect<false | ResolvedFunctionsBundle, StackBuildError> {
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
}

const resolveInstanceId = (
  instanceId: string | undefined,
): Effect.Effect<string | undefined, StackBuildError> =>
  instanceId === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(InstanceIdSchema)(instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new StackBuildError({
              detail: `Invalid instanceId: must match ${INSTANCE_ID_PATTERN}`,
              cause,
              reason: "invalid_config",
            }),
        ),
      );

function resolveStorageConfig(
  input: StorageConfig | undefined,
  raw: StorageConfig | false | undefined,
  ports: PortSet,
  opts: ResolveConfigOptions,
): Effect.Effect<ResolvedStorageConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return requiredPort(ports, "storagePort").pipe(
    Effect.map((port) => ({
      port,
      version: cfg.version ?? DEFAULT_VERSIONS.storage,
      dataDir: resolveDataDir(cfg.dataDir, opts.stackRoot!, "storage"),
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
): Effect.Effect<ResolvedVectorConfig | false, StackBuildError> {
  if (raw === false) return Effect.succeed(false);
  const cfg = input ?? {};
  return Effect.succeed({
    version: cfg.version ?? DEFAULT_VERSIONS.vector,
  });
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

export const rawServiceEnabled = (config: StackConfig, service: ServiceName): boolean => {
  switch (service) {
    case "postgres":
      return true;
    case "postgrest":
      return config.postgrest !== false;
    case "auth":
      return config.auth !== false;
    case "edge-runtime":
      return (
        ((config.mode ?? "native") !== "native" || config.edgeRuntime !== undefined) &&
        config.edgeRuntime !== false &&
        (config.edgeRuntime?.enabled ?? true) !== false
      );
    case "realtime":
      return config.realtime !== undefined && config.realtime !== false;
    case "storage":
      return config.storage !== undefined && config.storage !== false;
    case "imgproxy":
      return config.imgproxy !== undefined && config.imgproxy !== false;
    case "mailpit":
      return config.mailpit !== undefined && config.mailpit !== false;
    case "pgmeta":
      return config.pgmeta !== undefined && config.pgmeta !== false;
    case "studio":
      return config.studio !== undefined && config.studio !== false;
    case "analytics":
      return config.analytics !== undefined && config.analytics !== false;
    case "vector":
      return config.vector !== undefined && config.vector !== false;
    case "pooler":
      return config.pooler !== undefined && config.pooler !== false;
  }
};

const preparationPolicyRank: Readonly<Record<ServicePolicy, number>> = {
  off: 0,
  lazy: 1,
  eager: 2,
};

/**
 * Resolve policy declarations before roots, ports, or config-dependent effects
 * are acquired. This keeps unsupported policies a pure user/configuration error.
 */
const resolveServicePolicies = (
  config: StackConfig,
): Effect.Effect<ServicePolicyManifest, StackBuildError> =>
  Effect.gen(function* () {
    const policies: Record<ServiceName, ServicePolicy> = Record.map(SERVICE_CATALOG, () => "off");
    const requestedPolicies = config.servicePolicies ?? {};
    for (const service of SERVICE_NAMES) {
      const requested = requestedPolicies[service];
      if (service === "postgres" && requested !== undefined && requested !== "eager") {
        return yield* Effect.fail(
          new StackBuildError({
            detail: "postgres supports only the eager service preparation policy",
            reason: "invalid_config",
          }),
        );
      }

      const enabled = rawServiceEnabled(config, service);
      if (!enabled && requested !== undefined && requested !== "off") {
        return yield* Effect.fail(
          new StackBuildError({
            detail: `${service} cannot use the ${requested} service preparation policy because the service is not configured`,
            reason: "invalid_config",
          }),
        );
      }
      if (!enabled || requested === "off") {
        policies[service] = "off";
        continue;
      }

      const policy: Exclude<ServicePolicy, "off"> =
        requested === undefined ? DEFAULT_SERVICE_POLICIES[service] : requested;
      if (!serviceMetadata(service).preparation.supported.includes(policy)) {
        return yield* Effect.fail(
          new StackBuildError({
            detail: `${service} does not support the ${policy} service preparation policy`,
            reason: "invalid_config",
          }),
        );
      }
      policies[service] = policy;
    }

    let promoted = true;
    while (promoted) {
      promoted = false;
      for (const service of SERVICE_NAMES) {
        const policy = policies[service];
        if (policy === "off") continue;
        for (const dependency of serviceMetadata(service).activation.activates) {
          const dependencyPolicy = policies[dependency];
          if (
            dependencyPolicy === "off" ||
            preparationPolicyRank[dependencyPolicy] <= preparationPolicyRank[policy]
          ) {
            continue;
          }
          if (requestedPolicies[service] !== undefined) {
            return yield* Effect.fail(
              new StackBuildError({
                detail: `${dependency} uses the ${dependencyPolicy} preparation policy but requires ${service} to be at least ${dependencyPolicy}`,
                reason: "invalid_config",
              }),
            );
          }
          policies[service] = dependencyPolicy;
          promoted = true;
        }
      }
    }
    return policies;
  });

export interface PortRequestOptions {
  readonly preferredPorts?: PortSet;
  readonly runtime?: StackRuntimeSelection;
}

/**
 * Validate the allocation-relevant parts of a stack configuration and return
 * exact requests before automatic requests. The helper is allocation-free;
 * callers reserve the returned requests and pass the resulting ports into
 * `resolveConfig`.
 */
export const portRequestsForConfig = (
  input: StackConfig = {},
  options: PortRequestOptions = {},
): Effect.Effect<ReadonlyArray<PortReservationRequest>, StackBuildError> =>
  Effect.gen(function* () {
    if (
      input.mode !== undefined &&
      options.runtime !== undefined &&
      input.mode !== options.runtime.mode
    ) {
      return yield* Effect.fail(
        new StackBuildError({
          detail: `Selected ${options.runtime.mode} runtime does not match requested ${input.mode} mode`,
          reason: "invalid_config",
        }),
      );
    }
    const mode = options.runtime?.mode ?? input.mode ?? "native";
    const config: StackConfig = { ...input, mode };
    if (mode === "docker" && options.runtime?.containerRuntime == null) {
      return yield* Effect.fail(
        new StackBuildError({
          detail: "Docker mode requires a selected Docker or Podman runtime",
          reason: "invalid_config",
        }),
      );
    }

    // Deliberately first: unsupported policies and invalid explicit ports must
    // fail before a caller acquires any OS resource.
    yield* resolveServicePolicies(config);
    const postgresInput = config.postgres ?? {};
    const authInput = config.auth !== false ? (config.auth ?? undefined) : undefined;
    const edgeRuntimeInput = config.edgeRuntime !== false ? config.edgeRuntime : undefined;
    const realtimeInput = config.realtime !== false ? (config.realtime ?? undefined) : undefined;
    const storageInput = config.storage !== false ? (config.storage ?? undefined) : undefined;
    const imgproxyInput = config.imgproxy !== false ? (config.imgproxy ?? undefined) : undefined;
    const mailpitInput = config.mailpit !== false ? (config.mailpit ?? undefined) : undefined;
    const pgmetaInput = config.pgmeta !== false ? (config.pgmeta ?? undefined) : undefined;
    const studioInput = config.studio !== false ? (config.studio ?? undefined) : undefined;
    const analyticsInput = config.analytics !== false ? (config.analytics ?? undefined) : undefined;
    const poolerInput = config.pooler !== false ? (config.pooler ?? undefined) : undefined;
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
    const activeFields = portFieldsForConfigInput(config);
    for (const field of activeFields) {
      const explicit = explicitPortForField(field);
      if (
        explicit !== undefined &&
        (!Number.isInteger(explicit) || explicit < 1 || explicit > 65_535)
      ) {
        return yield* Effect.fail(
          new StackBuildError({
            detail: `Invalid port for ${field}: expected an integer between 1 and 65535`,
            reason: "invalid_config",
          }),
        );
      }
    }
    const unorderedRequests = activeFields.map((field) => {
      const explicit = explicitPortForField(field);
      if (explicit !== undefined) {
        return { field, selection: { kind: "exact", port: explicit } } as const;
      }
      const preferred = options.preferredPorts?.[field] ?? PORT_CATALOG[field].preferred;
      return preferred === undefined
        ? ({ field, selection: { kind: "automatic" } } as const)
        : ({ field, selection: { kind: "automatic", preferred } } as const);
    });
    return [
      ...unorderedRequests.filter((request) => request.selection.kind === "exact"),
      ...unorderedRequests.filter((request) => request.selection.kind === "automatic"),
    ];
  });

export function resolveConfig(
  input: StackConfig | undefined,
  opts: ResolveConfigOptions,
): Effect.Effect<ResolvedStackConfig, StackBuildError, FileSystem.FileSystem> {
  return Effect.suspend(() => {
    let roots: ResolvedRoots | undefined;
    const cleanup = () =>
      roots === undefined ? Effect.void : cleanupAutoManagedPaths(roots.autoManagedPaths);

    return Effect.gen(function* () {
      const inputConfig = input ?? {};
      const runtime: StackRuntimeSelection = opts.runtime ?? {
        mode: "native",
        containerRuntime: null,
      };
      const config: StackConfig = { ...inputConfig, mode: runtime.mode };
      // Deliberately first: unsupported policies must not create roots or reserve ports.
      const servicePolicies = yield* resolveServicePolicies(config);
      for (const field of portFieldsForConfigInput(config)) {
        if (opts.ports[field] === undefined) {
          return yield* Effect.fail(
            new StackBuildError({
              detail: `Missing resolved port for active field ${field}`,
              reason: "invalid_config",
            }),
          );
        }
      }
      const projectDir = config.projectDir ?? process.cwd();
      const instanceId = yield* resolveInstanceId(config.instanceId);
      const functions = yield* resolveFunctionsConfig(config, projectDir);
      const edgeRuntimeEnabled = servicePolicies["edge-runtime"] !== "off";
      if (functions !== false && !edgeRuntimeEnabled) {
        return yield* Effect.fail(
          new StackBuildError({
            detail: "Edge Functions require Edge Runtime to be enabled",
            reason: "invalid_config",
          }),
        );
      }
      roots = yield* resolveRoots(config, opts);
      const postgresInput = config.postgres ?? {};
      const postgrestInput =
        servicePolicies.postgrest !== "off" && config.postgrest !== false
          ? (config.postgrest ?? undefined)
          : undefined;
      const authInput =
        servicePolicies.auth !== "off" && config.auth !== false
          ? (config.auth ?? undefined)
          : undefined;
      const realtimeEnabled = servicePolicies.realtime !== "off";
      const storageEnabled = servicePolicies.storage !== "off";
      const imgproxyEnabled = servicePolicies.imgproxy !== "off";
      const mailpitEnabled = servicePolicies.mailpit !== "off";
      const pgmetaEnabled = servicePolicies.pgmeta !== "off";
      const studioEnabled = servicePolicies.studio !== "off";
      const analyticsEnabled = servicePolicies.analytics !== "off";
      const vectorEnabled = servicePolicies.vector !== "off";
      const poolerEnabled = servicePolicies.pooler !== "off";
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

      // Port selection is owned by the caller. Resolve the provided lease result only.
      const ports = opts.ports;

      const jwtSecret = config.jwtSecret ?? defaultJwtSecret;
      const anonJwt = generateJwt(jwtSecret, "anon");
      const serviceRoleJwt = generateJwt(jwtSecret, "service_role");
      const apiPort = yield* requiredPort(ports, "apiPort");
      const dbPort = yield* requiredPort(ports, "dbPort");
      const resolvedPorts: ResolvedPorts = { ...ports, apiPort, dbPort };

      return {
        instanceId,
        cacheRoot: roots.cacheRoot,
        stackRoot: roots.stackRoot,
        runtimeRoot: roots.runtimeRoot,
        projectDir,
        runtime,
        servicePolicies,
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
        autoManagedPaths: roots.autoManagedPaths,
        anonJwt,
        serviceRoleJwt,
        postgres: {
          port: dbPort,
          dataDir: postgresDataDir,
          version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
          autoExposeNewTables: postgresInput.autoExposeNewTables ?? true,
        },
        postgrest: yield* resolvePostgrestConfig(
          postgrestInput,
          servicePolicies.postgrest === "off" ? false : config.postgrest,
          ports,
        ),
        auth: yield* resolveAuthConfig(
          authInput,
          servicePolicies.auth === "off" ? false : config.auth,
          ports,
          apiPort,
        ),
        edgeRuntime: edgeRuntimeEnabled
          ? yield* resolveEdgeRuntimeConfig(edgeRuntimeInput, config.edgeRuntime, ports)
          : false,
        realtime: realtimeEnabled
          ? yield* resolveRealtimeConfig(realtimeInput, config.realtime, ports)
          : false,
        storage: storageEnabled
          ? yield* resolveStorageConfig(storageInput, config.storage, ports, {
              ...opts,
              stackRoot: roots.stackRoot,
            })
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
        vector: vectorEnabled ? yield* resolveVectorConfig(vectorInput, config.vector) : false,
        pooler: poolerEnabled
          ? yield* resolvePoolerConfig(poolerInput, config.pooler, ports)
          : false,
      };
    }).pipe(
      Effect.catchDefect((cause) =>
        cause instanceof StackBuildError ? Effect.fail(cause) : Effect.die(cause),
      ),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanup())),
    );
  });
}

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

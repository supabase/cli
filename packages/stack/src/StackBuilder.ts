// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native path joining is required for the temporary PostgreSQL alias boundary.
import { join } from "node:path";
import { buildGraph } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceDef } from "@supabase/process-compose";
import { Context, Effect, FileSystem, Layer, Scope } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { StackBuildError } from "./errors.ts";
import { generateJwks } from "./JwtGenerator.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import { shortTempPrefixRoot } from "./paths.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";
import {
  makeEdgeRuntimeServiceDocker,
  makeEdgeRuntimeServiceNative,
  prepareEdgeRuntimeBootstrap,
} from "./services/edge-runtime.ts";
import { makeImgproxyServiceDocker, makeImgproxyServiceNative } from "./services/imgproxy.ts";
import { makeMailpitServiceDocker, makeMailpitServiceNative } from "./services/mailpit.ts";
import { makePgmetaServiceDocker, makePgmetaServiceNative } from "./services/pgmeta.ts";
import { makePoolerServiceDocker, makePoolerServicesNative } from "./services/pooler.ts";
import {
  makePostgresInitService,
  makePostgresInitServiceDocker,
} from "./services/postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./services/postgres.ts";
import { makePostgrestService, makePostgrestServiceDocker } from "./services/postgrest.ts";
import { makeRealtimeServiceDocker, makeRealtimeServicesNative } from "./services/realtime.ts";
import { type ServiceDependency } from "./services/service-utils.ts";
import {
  LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
  LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
  makeStorageServiceDocker,
  makeStorageServiceNative,
} from "./services/storage.ts";
import { makeStudioServiceDocker, makeStudioServiceNative } from "./services/studio.ts";
import {
  makeVectorServiceDocker,
  makeVectorServiceNative,
  prepareVectorConfig,
} from "./services/vector.ts";
import { makeAnalyticsServiceDocker, makeAnalyticsServicesNative } from "./services/analytics.ts";
import {
  dependencyTimeoutSecondsForServices,
  POSTGRES_INIT_COMPLETION_BUDGET_SECONDS,
} from "./services/health-budgets.ts";
import type { PreparedStackArtifacts, ServiceResolution } from "./StackPreparation.ts";
import type { StackServiceProjectionCatalog } from "./StackStateProjection.ts";
import { SERVICE_NAMES, serviceMetadata } from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";
import { INSTANCE_ID_PATTERN, type ResolvedStackConfig } from "./StackConfig.ts";
import { dockerContainerName, stackIdentity } from "./StackIdentity.ts";
import type { VersionManifest } from "./versions.ts";

export interface BuildResult {
  readonly graph: ResolvedGraph;
  readonly cleanupTargets: CleanupTargets;
  readonly serviceProjection: StackServiceProjectionCatalog;
}

const dockerOnlyServices = SERVICE_NAMES.filter(
  (service) => serviceMetadata(service).runtimeSupport === "docker-only",
);
const nativeServices = SERVICE_NAMES.filter(
  (service) => serviceMetadata(service).runtimeSupport !== "docker-only",
);

// Serial health-check paths used by dependency waits; keep each path aligned
// with the corresponding service's transitive dependencies.
const postgresStartupPath: ReadonlyArray<ServiceName> = ["postgres"];
const storageStartupPath: ReadonlyArray<ServiceName> = ["postgres", "storage"];
const analyticsStartupPath: ReadonlyArray<ServiceName> = ["postgres", "analytics"];

/** Derive a stack-unique, valid Erlang short node name from the owned identity. */
const analyticsNodeName = (identityKey: string): string =>
  `logflare_${identityKey.replaceAll("-", "_")}`;

const postgresDependencyTimeoutSeconds = dependencyTimeoutSecondsForServices(postgresStartupPath);

const postgresDependencies: ReadonlyArray<ServiceDependency> = [
  { service: "postgres-init", condition: "completed" },
];

const privateServiceOwners: Readonly<Record<string, string>> = {
  "postgres-init": "postgres",
  "realtime-migrate": "realtime",
  "realtime-seed": "realtime",
  "analytics-migrate": "analytics",
  "pooler-migrate": "pooler",
  "pooler-bootstrap": "pooler",
};

const publicServiceProjection = (
  defs: ReadonlyArray<ServiceDef>,
): StackServiceProjectionCatalog => {
  const serviceProjection = new Map<
    string,
    {
      visibility: "public" | "internal";
      owner?: string;
      ownerStatusWhileActive?: "Initializing";
    }
  >();
  for (const def of defs) {
    if (SERVICE_NAMES.some((service) => service === def.name)) {
      serviceProjection.set(def.name, { visibility: "public" });
    }
    const owner = privateServiceOwners[def.name];
    if (owner !== undefined) {
      serviceProjection.set(def.name, {
        visibility: "internal",
        owner,
        ownerStatusWhileActive: "Initializing",
      });
    }
  }
  return serviceProjection;
};

const hasAutoManagedPath = (config: ResolvedStackConfig, path: string) =>
  config.autoManagedPaths.some(
    (managedPath) =>
      path === managedPath ||
      path.startsWith(`${managedPath}/`) ||
      path.startsWith(`${managedPath}\\`),
  );

const prepareNativeDirectory = (
  path: string,
  detail: string,
): Effect.Effect<void, StackBuildError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(path, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => new StackBuildError({ detail, cause })));
  });

const resolvedConfigForService = (config: ResolvedStackConfig, service: ServiceName) =>
  config[serviceMetadata(service).configKey];

const configuredServiceEnabled = (config: ResolvedStackConfig, service: ServiceName): boolean =>
  config.servicePolicies[service] !== "off" && resolvedConfigForService(config, service) !== false;

const prepareNativePostgresAlias = (
  preparedPath: string,
): Effect.Effect<string, StackBuildError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const aliasRoot = yield* Effect.acquireRelease(
      fs.makeTempDirectory({
        directory: shortTempPrefixRoot(),
        prefix: "supabase-stack-postgres-",
      }),
      (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.ignore),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new StackBuildError({
            detail: "Failed to create a private native PostgreSQL binary directory",
            cause,
          }),
      ),
    );
    const aliasPath = join(aliasRoot, "bundle");
    if (/\s/.test(aliasPath) || (process.platform !== "darwin" && process.platform !== "linux")) {
      yield* fs.remove(aliasRoot, { recursive: true, force: true }).pipe(Effect.ignore);
      return yield* new StackBuildError({
        detail: "Native PostgreSQL requires a Unix temporary path without whitespace",
        reason: "invalid_config",
      });
    }

    yield* fs.symlink(preparedPath, aliasPath).pipe(
      Effect.mapError(
        (cause) =>
          new StackBuildError({
            detail: "Failed to publish the native PostgreSQL binary alias",
            cause,
          }),
      ),
    );
    return aliasPath;
  });

export const validateResolvedConfig = (
  config: ResolvedStackConfig,
): Effect.Effect<void, StackBuildError> =>
  Effect.gen(function* () {
    if (config.instanceId !== undefined && !INSTANCE_ID_PATTERN.test(config.instanceId)) {
      return yield* new StackBuildError({
        detail: `Invalid instanceId: must match ${INSTANCE_ID_PATTERN}`,
        reason: "invalid_config",
      });
    }

    if (config.runtime.mode === "native") {
      const enabledDockerOnly = dockerOnlyServices.filter(
        (service) => resolvedConfigForService(config, service) !== false,
      );
      if (enabledDockerOnly.length > 0) {
        return yield* new StackBuildError({
          detail: `Native mode supports only ${nativeServices.join(", ")}. Disable ${enabledDockerOnly.join(", ")} or select Docker mode with a usable Docker or Podman runtime.`,
          reason: "invalid_config",
        });
      }
    }

    if (
      configuredServiceEnabled(config, "imgproxy") &&
      !configuredServiceEnabled(config, "storage")
    ) {
      return yield* new StackBuildError({
        detail: "imgproxy requires storage to be enabled",
        reason: "invalid_config",
      });
    }

    if (
      configuredServiceEnabled(config, "vector") &&
      !configuredServiceEnabled(config, "analytics")
    ) {
      return yield* new StackBuildError({
        detail: "vector requires analytics to be enabled",
        reason: "invalid_config",
      });
    }

    if (configuredServiceEnabled(config, "studio") && !configuredServiceEnabled(config, "pgmeta")) {
      return yield* new StackBuildError({
        detail: "studio requires pgmeta to be enabled",
        reason: "invalid_config",
      });
    }
  });

export const enabledServicesForConfig = (config: ResolvedStackConfig): ReadonlyArray<ServiceName> =>
  SERVICE_NAMES.filter(
    (service) =>
      config.servicePolicies?.[service] !== "off" &&
      resolvedConfigForService(config, service) !== false,
  );

export const versionsForConfig = (config: ResolvedStackConfig): Partial<VersionManifest> => {
  const versions: Partial<Record<ServiceName, string>> = {};
  for (const service of enabledServicesForConfig(config)) {
    const serviceConfig = resolvedConfigForService(config, service);
    if (serviceConfig !== false) {
      versions[service] = serviceConfig.version;
    }
  }
  return versions;
};

const requirePreparedResolution = (
  prepared: PreparedStackArtifacts,
  service: ServiceName,
): Effect.Effect<ServiceResolution, StackBuildError> => {
  const resolution = prepared.resolutions[service];
  return resolution !== undefined
    ? Effect.succeed(resolution)
    : Effect.fail(
        new StackBuildError({
          detail: `Missing prepared resolution for ${service}`,
        }),
      );
};

export class StackBuilder extends Context.Service<
  StackBuilder,
  {
    readonly build: (
      config: ResolvedStackConfig,
      prepared: PreparedStackArtifacts,
    ) => Effect.Effect<BuildResult, StackBuildError, FileSystem.FileSystem | Scope.Scope>;
  }
>()("local/StackBuilder") {
  static layer: Layer.Layer<StackBuilder> = Layer.succeed(this, {
    build: (config: ResolvedStackConfig, prepared: PreparedStackArtifacts) =>
      Effect.gen(function* () {
        yield* validateResolvedConfig(config);

        const requireContainerRuntime = Effect.suspend(() =>
          config.runtime.mode === "native"
            ? Effect.fail(
                new StackBuildError({
                  detail: "A Docker service requires a selected container runtime",
                  reason: "invalid_config",
                }),
              )
            : Effect.succeed(config.runtime.containerRuntime),
        );

        const platform = yield* detectPlatform;
        const serviceHost = dockerHostAddress(platform.os);
        const projectDir = config.projectDir;

        const postgresResolution = yield* requirePreparedResolution(prepared, "postgres");

        if (postgresResolution.type === "docker") {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(config.postgres.dataDir, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: "Failed to prepare the PostgreSQL data directory",
                  cause,
                }),
            ),
          );
        }

        const authResolution = !configuredServiceEnabled(config, "auth")
          ? false
          : yield* requirePreparedResolution(prepared, "auth");

        const postgrestResolution = !configuredServiceEnabled(config, "postgrest")
          ? false
          : yield* requirePreparedResolution(prepared, "postgrest");
        const mailpitEnabled =
          config.mailpit !== false && configuredServiceEnabled(config, "mailpit");
        const mailpitSmtpHost = mailpitEnabled ? serviceHost : undefined;
        const nativeMailpitSmtpHost = mailpitEnabled ? "127.0.0.1" : undefined;
        const mailpitSmtpPort = mailpitEnabled ? config.mailpit.smtpPort : undefined;
        const mailpitAdminEmail = mailpitEnabled ? config.mailpit.adminEmail : undefined;
        const mailpitSenderName = mailpitEnabled ? config.mailpit.senderName : undefined;

        const postgresInitCompletionBudgetSeconds = POSTGRES_INIT_COMPLETION_BUDGET_SECONDS;
        const postgresConsumerDependencyTimeoutSeconds =
          postgresDependencyTimeoutSeconds + postgresInitCompletionBudgetSeconds;
        const storageDependencyTimeoutSeconds =
          dependencyTimeoutSecondsForServices(storageStartupPath) +
          postgresInitCompletionBudgetSeconds;
        const analyticsDependencyTimeoutSeconds =
          dependencyTimeoutSecondsForServices(analyticsStartupPath) +
          postgresInitCompletionBudgetSeconds;
        const jwtJwks = generateJwks(config.jwtSecret);
        const identity = stackIdentity(config);

        const postgresService =
          postgresResolution.type === "binary"
            ? makePostgresService({
                binPath: yield* prepareNativePostgresAlias(postgresResolution.path),
                dataDir: config.postgres.dataDir,
                port: config.dbPort,
                cleanupDataDirOnExit: hasAutoManagedPath(config, config.postgres.dataDir),
                dependencies: [],
              })
            : makePostgresServiceDocker({
                runtime: yield* requireContainerRuntime,
                image: postgresResolution.image,
                dataDir: config.postgres.dataDir,
                port: config.dbPort,
                platformOs: platform.os,
                identity,
                cleanupDataDirOnExit: hasAutoManagedPath(config, config.postgres.dataDir),
                dependencies: [],
              });

        const defs: Array<ServiceDef & { enabled: boolean }> = [
          {
            ...postgresService,
            enabled: true,
          },
        ];

        defs.push({
          ...(postgresResolution.type === "binary"
            ? makePostgresInitService({
                postgresDir: postgresResolution.path,
                dbPort: config.dbPort,
                jwtSecret: config.jwtSecret,
                jwtExpiry: config.auth !== false ? config.auth.jwtExpiry : 3600,
                autoExposeNewTables: config.postgres.autoExposeNewTables,
                dependencies: [{ service: "postgres", condition: "healthy" }],
              })
            : makePostgresInitServiceDocker({
                runtime: yield* requireContainerRuntime,
                dbPort: config.dbPort,
                jwtSecret: config.jwtSecret,
                jwtExpiry: config.auth !== false ? config.auth.jwtExpiry : 3600,
                autoExposeNewTables: config.postgres.autoExposeNewTables,
                identity,
                dependencies: [{ service: "postgres", condition: "healthy" }],
              })),
          dependencyTimeoutSeconds: postgresDependencyTimeoutSeconds,
          enabled: true,
        });

        if (
          config.postgrest !== false &&
          configuredServiceEnabled(config, "postgrest") &&
          postgrestResolution !== false
        ) {
          defs.push({
            ...(postgrestResolution.type === "binary"
              ? makePostgrestService({
                  binPath: postgrestResolution.path,
                  dbPort: config.dbPort,
                  port: config.postgrest.port,
                  schemas: config.postgrest.schemas,
                  extraSearchPath: config.postgrest.extraSearchPath,
                  maxRows: config.postgrest.maxRows,
                  jwtSecret: config.jwtSecret,
                  dependencies: postgresDependencies,
                })
              : makePostgrestServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: postgrestResolution.image,
                  dbHost: serviceHost,
                  dbPort: config.dbPort,
                  port: config.postgrest.port,
                  adminPort: config.postgrest.adminPort,
                  schemas: config.postgrest.schemas,
                  extraSearchPath: config.postgrest.extraSearchPath,
                  maxRows: config.postgrest.maxRows,
                  jwtSecret: config.jwtSecret,
                  platformOs: platform.os,
                  identity,
                  dependencies: postgresDependencies,
                })),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (
          config.auth !== false &&
          configuredServiceEnabled(config, "auth") &&
          authResolution !== false
        ) {
          defs.push({
            ...(authResolution.type === "binary"
              ? makeAuthServiceNative({
                  binPath: authResolution.path,
                  dbPort: config.dbPort,
                  authPort: config.auth.port,
                  siteUrl: config.auth.siteUrl,
                  jwtSecret: config.jwtSecret,
                  jwtExpiry: config.auth.jwtExpiry,
                  externalUrl: config.auth.externalUrl,
                  smtpHost: nativeMailpitSmtpHost,
                  smtpPort: mailpitSmtpPort,
                  smtpAdminEmail: mailpitAdminEmail,
                  smtpSenderName: mailpitSenderName,
                  dependencies: postgresDependencies,
                })
              : makeAuthServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: authResolution.image,
                  dbHost: serviceHost,
                  dbPort: config.dbPort,
                  authPort: config.auth.port,
                  siteUrl: config.auth.siteUrl,
                  jwtSecret: config.jwtSecret,
                  jwtExpiry: config.auth.jwtExpiry,
                  externalUrl: config.auth.externalUrl,
                  smtpHost: mailpitSmtpHost,
                  smtpPort: mailpitSmtpPort,
                  smtpAdminEmail: mailpitAdminEmail,
                  smtpSenderName: mailpitSenderName,
                  platformOs: platform.os,
                  identity,
                  dependencies: postgresDependencies,
                })),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.edgeRuntime !== false && configuredServiceEnabled(config, "edge-runtime")) {
          const edgeRuntimeResolution = yield* requirePreparedResolution(prepared, "edge-runtime");
          const edgeRuntimeBootstrapDir = yield* prepareEdgeRuntimeBootstrap(config.runtimeRoot);
          defs.push({
            ...(edgeRuntimeResolution.type === "binary"
              ? makeEdgeRuntimeServiceNative({
                  binPath: edgeRuntimeResolution.path,
                  runtimeRoot: config.runtimeRoot,
                  bootstrapDir: edgeRuntimeBootstrapDir,
                  projectDir,
                  port: config.edgeRuntime.port,
                  inspectorPort: config.edgeRuntime.inspectorPort,
                  policy: config.edgeRuntime.policy,
                  env: config.edgeRuntime.env,
                  dependencies: postgresDependencies,
                })
              : makeEdgeRuntimeServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: edgeRuntimeResolution.image,
                  identity,
                  runtimeRoot: config.runtimeRoot,
                  bootstrapDir: edgeRuntimeBootstrapDir,
                  projectDir,
                  port: config.edgeRuntime.port,
                  inspectorPort: config.edgeRuntime.inspectorPort,
                  policy: config.edgeRuntime.policy,
                  env: config.edgeRuntime.env,
                  platformOs: platform.os,
                  dependencies: postgresDependencies,
                })),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.mailpit !== false && configuredServiceEnabled(config, "mailpit")) {
          const mailpitResolution = yield* requirePreparedResolution(prepared, "mailpit");
          defs.push({
            ...(mailpitResolution.type === "binary"
              ? makeMailpitServiceNative({
                  binPath: mailpitResolution.path,
                  dataDir: join(config.stackRoot, "data", "mailpit"),
                  webPort: config.mailpit.port,
                  smtpPort: config.mailpit.smtpPort,
                  pop3Port: config.mailpit.pop3Port,
                  dependencies: [],
                })
              : makeMailpitServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: mailpitResolution.image,
                  identity,
                  webPort: config.mailpit.port,
                  smtpPort: config.mailpit.smtpPort,
                  pop3Port: config.mailpit.pop3Port,
                  platformOs: platform.os,
                  dependencies: [],
                })),
            enabled: true,
          });
          if (mailpitResolution.type === "binary") {
            yield* prepareNativeDirectory(
              join(config.stackRoot, "data", "mailpit"),
              "Failed to prepare the native Mailpit data directory",
            );
          }
        }

        if (config.realtime !== false && configuredServiceEnabled(config, "realtime")) {
          const realtimeResolution = yield* requirePreparedResolution(prepared, "realtime");
          if (realtimeResolution.type === "binary") {
            const bundle = makeRealtimeServicesNative({
              binPath: realtimeResolution.path,
              port: config.realtime.port,
              dbPort: config.dbPort,
              jwtSecret: config.jwtSecret,
              jwtJwks,
              tenantId: config.realtime.tenantId,
              encryptionKey: config.realtime.encryptionKey,
              secretKeyBase: config.realtime.secretKeyBase,
              maxHeaderLength: config.realtime.maxHeaderLength,
              dependencies: postgresDependencies,
            });
            defs.push(
              {
                ...bundle.migrate,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
              {
                ...bundle.seed,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
              {
                ...bundle.server,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
            );
          } else {
            defs.push({
              ...makeRealtimeServiceDocker({
                runtime: yield* requireContainerRuntime,
                image: realtimeResolution.image,
                port: config.realtime.port,
                identity,
                dbHost: serviceHost,
                dbPort: config.dbPort,
                jwtSecret: config.jwtSecret,
                jwtJwks,
                tenantId: config.realtime.tenantId,
                encryptionKey: config.realtime.encryptionKey,
                secretKeyBase: config.realtime.secretKeyBase,
                maxHeaderLength: config.realtime.maxHeaderLength,
                platformOs: platform.os,
                dependencies: postgresDependencies,
              }),
              dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
              enabled: true,
            });
          }
        }

        if (config.storage !== false && configuredServiceEnabled(config, "storage")) {
          const storageResolution = yield* requirePreparedResolution(prepared, "storage");
          const imgproxyEnabled = configuredServiceEnabled(config, "imgproxy");
          const imgproxyPort = config.imgproxy === false ? 0 : config.imgproxy.port;
          if (storageResolution.type === "binary") {
            yield* prepareNativeDirectory(
              config.storage.dataDir,
              "Failed to prepare the native Storage data directory",
            );
          }
          defs.push({
            ...(storageResolution.type === "binary"
              ? makeStorageServiceNative({
                  binPath: storageResolution.path,
                  port: config.storage.port,
                  dbPort: config.dbPort,
                  dataDir: config.storage.dataDir,
                  anonKey: config.publishableKey,
                  serviceKey: config.secretKey,
                  jwtSecret: config.jwtSecret,
                  jwtJwks,
                  fileSizeLimit: config.storage.fileSizeLimit,
                  enableImageTransformation: imgproxyEnabled,
                  imgproxyUrl: imgproxyEnabled ? `http://127.0.0.1:${imgproxyPort}` : "",
                  s3ProtocolEnabled: config.storage.s3ProtocolEnabled,
                  dependencies: postgresDependencies,
                  cleanupDataDirOnExit: hasAutoManagedPath(config, config.storage.dataDir),
                })
              : makeStorageServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: storageResolution.image,
                  port: config.storage.port,
                  identity,
                  dbHost: serviceHost,
                  dbPort: config.dbPort,
                  dataDir: config.storage.dataDir,
                  anonKey: config.publishableKey,
                  serviceKey: config.secretKey,
                  jwtSecret: config.jwtSecret,
                  jwtJwks,
                  fileSizeLimit: config.storage.fileSizeLimit,
                  enableImageTransformation: imgproxyEnabled,
                  imgproxyUrl: imgproxyEnabled ? `http://${serviceHost}:${imgproxyPort}` : "",
                  s3ProtocolEnabled: config.storage.s3ProtocolEnabled,
                  platformOs: platform.os,
                  dependencies: postgresDependencies,
                  cleanupDataDirOnExit: hasAutoManagedPath(config, config.storage.dataDir),
                })),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.imgproxy !== false && configuredServiceEnabled(config, "imgproxy")) {
          const storageConfig = config.storage;
          const imgproxyResolution = yield* requirePreparedResolution(prepared, "imgproxy");
          defs.push({
            ...(imgproxyResolution.type === "binary"
              ? makeImgproxyServiceNative({
                  binPath: imgproxyResolution.path,
                  port: config.imgproxy.port,
                  dependencies: [{ service: "storage", condition: "healthy" }],
                })
              : makeImgproxyServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: imgproxyResolution.image,
                  port: config.imgproxy.port,
                  identity,
                  dataDir: storageConfig === false ? "" : storageConfig.dataDir,
                  platformOs: platform.os,
                  dependencies: [{ service: "storage", condition: "healthy" }],
                })),
            dependencyTimeoutSeconds: storageDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.pgmeta !== false && configuredServiceEnabled(config, "pgmeta")) {
          const pgmetaResolution = yield* requirePreparedResolution(prepared, "pgmeta");
          defs.push({
            ...(pgmetaResolution.type === "binary"
              ? makePgmetaServiceNative({
                  binPath: pgmetaResolution.path,
                  port: config.pgmeta.port,
                  dbPort: config.dbPort,
                  dependencies: postgresDependencies,
                })
              : makePgmetaServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: pgmetaResolution.image,
                  identity,
                  port: config.pgmeta.port,
                  dbHost: serviceHost,
                  dbPort: config.dbPort,
                  platformOs: platform.os,
                  dependencies: postgresDependencies,
                })),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.analytics !== false && configuredServiceEnabled(config, "analytics")) {
          const analyticsResolution = yield* requirePreparedResolution(prepared, "analytics");
          if (analyticsResolution.type === "binary") {
            yield* prepareNativeDirectory(
              join(config.runtimeRoot, "analytics"),
              "Failed to prepare the native Analytics runtime directory",
            );
            const bundle = makeAnalyticsServicesNative({
              binPath: analyticsResolution.path,
              runtimeRoot: config.runtimeRoot,
              nodeName: analyticsNodeName(identity.key),
              hostPort: config.analytics.port,
              dbPort: config.dbPort,
              apiKey: config.analytics.apiKey,
              backend: config.analytics.backend,
              dependencies: postgresDependencies,
            });
            defs.push(
              {
                ...bundle.migrate,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
              {
                ...bundle.server,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
            );
          } else {
            defs.push({
              ...makeAnalyticsServiceDocker({
                runtime: yield* requireContainerRuntime,
                image: analyticsResolution.image,
                identity,
                hostPort: config.analytics.port,
                platformOs: platform.os,
                dbHost: serviceHost,
                dbPort: config.dbPort,
                apiKey: config.analytics.apiKey,
                backend: config.analytics.backend,
                dependencies: postgresDependencies,
              }),
              dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
              enabled: true,
            });
          }
        }

        if (config.vector !== false && configuredServiceEnabled(config, "vector")) {
          const analyticsConfig = config.analytics;
          const vectorResolution = yield* requirePreparedResolution(prepared, "vector");
          if (analyticsConfig === false) {
            return yield* new StackBuildError({
              detail: "vector requires analytics to be enabled",
              reason: "invalid_config",
            });
          }
          if (vectorResolution.type === "binary") {
            const adminPort = config.vector.adminPort;
            if (adminPort === undefined) {
              return yield* new StackBuildError({
                detail: "Native Vector requires a resolved private admin port",
                reason: "invalid_config",
              });
            }
            yield* prepareVectorConfig({
              runtimeRoot: config.runtimeRoot,
              adminPort,
              analyticsPort: analyticsConfig.port,
              analyticsApiKey: analyticsConfig.apiKey,
            });
            defs.push({
              ...makeVectorServiceNative({
                binPath: vectorResolution.path,
                runtimeRoot: config.runtimeRoot,
                adminPort,
                analyticsPort: analyticsConfig.port,
                analyticsApiKey: analyticsConfig.apiKey,
                dependencies: [{ service: "analytics", condition: "healthy" }],
              }),
              dependencyTimeoutSeconds: analyticsDependencyTimeoutSeconds,
              enabled: true,
            });
          } else {
            defs.push({
              ...makeVectorServiceDocker({
                runtime: yield* requireContainerRuntime,
                image: vectorResolution.image,
                identity,
                serviceHost,
                analyticsPort: analyticsConfig.port,
                analyticsApiKey: analyticsConfig.apiKey,
                platformOs: platform.os,
                dependencies: [{ service: "analytics", condition: "healthy" }],
              }),
              dependencyTimeoutSeconds: analyticsDependencyTimeoutSeconds,
              enabled: true,
            });
          }
        }

        if (config.pooler !== false && configuredServiceEnabled(config, "pooler")) {
          const poolerResolution = yield* requirePreparedResolution(prepared, "pooler");
          if (poolerResolution.type === "binary") {
            yield* prepareNativeDirectory(
              join(config.runtimeRoot, "pooler"),
              "Failed to prepare the native Pooler runtime directory",
            );
            const bundle = makePoolerServicesNative({
              binPath: poolerResolution.path,
              runtimeRoot: config.runtimeRoot,
              adminPort: config.pooler.apiPort,
              port: config.pooler.port,
              dbPort: config.dbPort,
              poolMode: config.pooler.mode,
              defaultPoolSize: config.pooler.defaultPoolSize,
              maxClientConn: config.pooler.maxClientConn,
              jwtSecret: config.jwtSecret,
              tenantId: config.pooler.tenantId,
              encryptionKey: config.pooler.encryptionKey,
              secretKeyBase: config.pooler.secretKeyBase,
              dependencies: postgresDependencies,
            });
            defs.push(
              {
                ...bundle.migrate,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
              {
                ...bundle.bootstrap,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
              {
                ...bundle.server,
                dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
                enabled: true,
              },
            );
          } else {
            defs.push({
              ...makePoolerServiceDocker({
                runtime: yield* requireContainerRuntime,
                image: poolerResolution.image,
                identity,
                hostAdminPort: config.pooler.apiPort,
                hostPort: config.pooler.port,
                platformOs: platform.os,
                dbHost: serviceHost,
                dbPort: config.dbPort,
                poolMode: config.pooler.mode,
                defaultPoolSize: config.pooler.defaultPoolSize,
                maxClientConn: config.pooler.maxClientConn,
                jwtSecret: config.jwtSecret,
                tenantId: config.pooler.tenantId,
                encryptionKey: config.pooler.encryptionKey,
                secretKeyBase: config.pooler.secretKeyBase,
                dependencies: postgresDependencies,
              }),
              dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
              enabled: true,
            });
          }
        }

        if (config.studio !== false && configuredServiceEnabled(config, "studio")) {
          const pgmetaConfig = config.pgmeta;
          const studioResolution = yield* requirePreparedResolution(prepared, "studio");
          const analyticsConfig = config.analytics;
          const pgmetaEnabled = configuredServiceEnabled(config, "pgmeta");
          const analyticsEnabled = configuredServiceEnabled(config, "analytics");
          const pgmetaPort = pgmetaConfig === false ? 0 : pgmetaConfig.port;
          const analyticsPort = analyticsConfig === false ? 0 : analyticsConfig.port;
          const analyticsBackend = analyticsConfig === false ? "postgres" : analyticsConfig.backend;
          const analyticsApiKey = analyticsConfig === false ? "api-key" : analyticsConfig.apiKey;
          defs.push({
            ...(studioResolution.type === "binary"
              ? makeStudioServiceNative({
                  binPath: studioResolution.path,
                  port: config.studio.port,
                  apiUrl: config.studio.apiUrl,
                  publicApiUrl: `http://127.0.0.1:${config.apiPort}`,
                  pgmetaUrl: !pgmetaEnabled ? "" : `http://127.0.0.1:${pgmetaPort}`,
                  publishableKey: config.publishableKey,
                  secretKey: config.secretKey,
                  s3ProtocolAccessKeyId: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
                  s3ProtocolAccessKeySecret: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
                  jwtSecret: config.jwtSecret,
                  analyticsEnabled,
                  analyticsBackend: analyticsEnabled ? analyticsBackend : "postgres",
                  analyticsUrl: !analyticsEnabled ? "" : `http://127.0.0.1:${analyticsPort}`,
                  analyticsApiKey: analyticsEnabled ? analyticsApiKey : "api-key",
                  dependencies: !analyticsEnabled
                    ? [{ service: "pgmeta", condition: "healthy" }]
                    : [
                        { service: "pgmeta", condition: "healthy" },
                        { service: "analytics", condition: "healthy" },
                      ],
                })
              : makeStudioServiceDocker({
                  runtime: yield* requireContainerRuntime,
                  image: studioResolution.image,
                  identity,
                  port: config.studio.port,
                  apiUrl: config.studio.apiUrl,
                  publicApiUrl: `http://127.0.0.1:${config.apiPort}`,
                  pgmetaUrl: !pgmetaEnabled ? "" : `http://${serviceHost}:${pgmetaPort}`,
                  publishableKey: config.publishableKey,
                  secretKey: config.secretKey,
                  s3ProtocolAccessKeyId: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
                  s3ProtocolAccessKeySecret: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
                  jwtSecret: config.jwtSecret,
                  analyticsEnabled,
                  analyticsBackend: analyticsEnabled ? analyticsBackend : "postgres",
                  analyticsUrl: analyticsEnabled ? `http://${serviceHost}:${analyticsPort}` : "",
                  analyticsApiKey: analyticsEnabled ? analyticsApiKey : "api-key",
                  platformOs: platform.os,
                  dependencies: !analyticsEnabled
                    ? [{ service: "pgmeta", condition: "healthy" }]
                    : [
                        { service: "pgmeta", condition: "healthy" },
                        { service: "analytics", condition: "healthy" },
                      ],
                })),
            dependencyTimeoutSeconds: analyticsDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        const dockerContainerNames = SERVICE_NAMES.filter((service) =>
          defs.some(
            (def) =>
              def.name === service &&
              config.runtime.mode === "docker" &&
              def.command === config.runtime.containerRuntime,
          ),
        ).map((service) => dockerContainerName(service, identity.key));

        const graph = yield* buildGraph(defs).pipe(
          Effect.mapError(
            (cause) =>
              new StackBuildError({
                detail: "Failed to build dependency graph",
                cause,
              }),
          ),
        );

        return {
          graph,
          cleanupTargets: {
            dockerContainerNames,
          },
          serviceProjection: publicServiceProjection(defs),
        };
      }),
  });
}

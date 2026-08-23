// oxlint-disable effecttsgo/node-builtin-import -- Pure path/config helpers use the host path API at a synchronous platform boundary.
import { join } from "node:path";
import { buildGraph } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceDef } from "@supabase/process-compose";
import { Context, Effect, FileSystem, Layer, Scope } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { StackBuildError } from "./errors.ts";
import { generateJwks } from "./JwtGenerator.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import { shortTempPrefixRoot } from "./paths.ts";
import { makeAnalyticsServiceDocker } from "./services/analytics.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";
import {
  makeEdgeRuntimeServiceDocker,
  prepareEdgeRuntimeBootstrap,
} from "./services/edge-runtime.ts";
import { makeImgproxyServiceDocker } from "./services/imgproxy.ts";
import { makeMailpitServiceDocker } from "./services/mailpit.ts";
import { makePgmetaServiceDocker } from "./services/pgmeta.ts";
import { makePoolerServiceDocker } from "./services/pooler.ts";
import {
  makePostgresInitService,
  makePostgresInitServiceDocker,
} from "./services/postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./services/postgres.ts";
import { makePostgrestService, makePostgrestServiceDocker } from "./services/postgrest.ts";
import { makeRealtimeServiceDocker } from "./services/realtime.ts";
import { type ServiceDependency } from "./services/service-utils.ts";
import {
  LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
  LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
  makeStorageServiceDocker,
} from "./services/storage.ts";
import { makeStudioServiceDocker } from "./services/studio.ts";
import { makeVectorServiceDocker } from "./services/vector.ts";
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

const postgresDependencyTimeoutSeconds = dependencyTimeoutSecondsForServices(postgresStartupPath);

const postgresDependencies: ReadonlyArray<ServiceDependency> = [
  { service: "postgres-init", condition: "completed" },
];

const publicServiceProjection = (
  defs: ReadonlyArray<ServiceDef>,
): StackServiceProjectionCatalog => {
  const serviceProjection: Map<
    string,
    {
      visibility: "public" | "internal";
      owner?: string;
      ownerStatusWhileActive?: "Initializing";
    }
  > = new Map(defs.map((def) => [def.name, { visibility: "public" as const }] as const));

  serviceProjection.set("postgres-init", {
    visibility: "internal",
    owner: "postgres",
    ownerStatusWhileActive: "Initializing",
  });

  return serviceProjection;
};

const hasAutoManagedPath = (config: ResolvedStackConfig, path: string) =>
  config.autoManagedPaths.some(
    (managedPath) =>
      path === managedPath ||
      path.startsWith(`${managedPath}/`) ||
      path.startsWith(`${managedPath}\\`),
  );

const resolvedConfigForService = (config: ResolvedStackConfig, service: ServiceName) =>
  config[serviceMetadata(service).configKey];

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

    if (config.imgproxy !== false && config.storage === false) {
      return yield* new StackBuildError({
        detail: "imgproxy requires storage to be enabled",
        reason: "invalid_config",
      });
    }

    if (config.vector !== false && config.analytics === false) {
      return yield* new StackBuildError({
        detail: "vector requires analytics to be enabled",
        reason: "invalid_config",
      });
    }

    if (config.studio !== false && config.pgmeta === false) {
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

const requirePreparedDockerImage = (
  prepared: PreparedStackArtifacts,
  service: ServiceName,
): Effect.Effect<string, StackBuildError> =>
  requirePreparedResolution(prepared, service).pipe(
    Effect.flatMap((resolution) =>
      resolution.type === "docker"
        ? Effect.succeed(resolution.image)
        : Effect.fail(
            new StackBuildError({
              detail: `Expected a docker image for ${service}`,
            }),
          ),
    ),
  );

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

        const authResolution =
          config.auth === false ? false : yield* requirePreparedResolution(prepared, "auth");

        const postgrestResolution =
          config.postgrest === false
            ? false
            : yield* requirePreparedResolution(prepared, "postgrest");

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

        if (config.postgrest !== false && postgrestResolution !== false) {
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

        if (config.auth !== false && authResolution !== false) {
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
                  smtpHost: config.mailpit !== false ? serviceHost : undefined,
                  smtpPort: config.mailpit !== false ? config.mailpit.smtpPort : undefined,
                  smtpAdminEmail: config.mailpit !== false ? config.mailpit.adminEmail : undefined,
                  smtpSenderName: config.mailpit !== false ? config.mailpit.senderName : undefined,
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
                  smtpHost: config.mailpit !== false ? serviceHost : undefined,
                  smtpPort: config.mailpit !== false ? config.mailpit.smtpPort : undefined,
                  smtpAdminEmail: config.mailpit !== false ? config.mailpit.adminEmail : undefined,
                  smtpSenderName: config.mailpit !== false ? config.mailpit.senderName : undefined,
                  platformOs: platform.os,
                  identity,
                  dependencies: postgresDependencies,
                })),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.edgeRuntime !== false) {
          const edgeRuntimeImage = yield* requirePreparedDockerImage(prepared, "edge-runtime");
          const edgeRuntimeBootstrapDir = yield* prepareEdgeRuntimeBootstrap(config.runtimeRoot);
          defs.push({
            ...makeEdgeRuntimeServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: edgeRuntimeImage,
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
            }),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.mailpit !== false) {
          const mailpitImage = yield* requirePreparedDockerImage(prepared, "mailpit");
          defs.push({
            ...makeMailpitServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: mailpitImage,
              identity,
              webPort: config.mailpit.port,
              smtpPort: config.mailpit.smtpPort,
              pop3Port: config.mailpit.pop3Port,
              platformOs: platform.os,
              dependencies: [],
            }),
            enabled: true,
          });
        }

        if (config.realtime !== false) {
          const realtimeImage = yield* requirePreparedDockerImage(prepared, "realtime");
          defs.push({
            ...makeRealtimeServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: realtimeImage,
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

        if (config.storage !== false) {
          const storageImage = yield* requirePreparedDockerImage(prepared, "storage");
          defs.push({
            ...makeStorageServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: storageImage,
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
              enableImageTransformation: config.imgproxy !== false,
              imgproxyUrl:
                config.imgproxy !== false ? `http://${serviceHost}:${config.imgproxy.port}` : "",
              s3ProtocolEnabled: config.storage.s3ProtocolEnabled,
              platformOs: platform.os,
              dependencies: postgresDependencies,
              cleanupDataDirOnExit: hasAutoManagedPath(config, config.storage.dataDir),
            }),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.imgproxy !== false) {
          const storageConfig = config.storage;
          const imgproxyImage = yield* requirePreparedDockerImage(prepared, "imgproxy");
          defs.push({
            ...makeImgproxyServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: imgproxyImage,
              port: config.imgproxy.port,
              identity,
              dataDir: storageConfig === false ? "" : storageConfig.dataDir,
              platformOs: platform.os,
              dependencies: [{ service: "storage", condition: "healthy" }],
            }),
            dependencyTimeoutSeconds: storageDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.pgmeta !== false) {
          const pgmetaImage = yield* requirePreparedDockerImage(prepared, "pgmeta");
          defs.push({
            ...makePgmetaServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: pgmetaImage,
              identity,
              port: config.pgmeta.port,
              dbHost: serviceHost,
              dbPort: config.dbPort,
              platformOs: platform.os,
              dependencies: postgresDependencies,
            }),
            dependencyTimeoutSeconds: postgresConsumerDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.analytics !== false) {
          const analyticsImage = yield* requirePreparedDockerImage(prepared, "analytics");
          defs.push({
            ...makeAnalyticsServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: analyticsImage,
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

        if (config.vector !== false) {
          const analyticsConfig = config.analytics;
          const vectorImage = yield* requirePreparedDockerImage(prepared, "vector");
          defs.push({
            ...makeVectorServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: vectorImage,
              identity,
              serviceHost,
              analyticsPort: analyticsConfig === false ? 0 : analyticsConfig.port,
              analyticsApiKey: analyticsConfig === false ? "api-key" : analyticsConfig.apiKey,
              platformOs: platform.os,
              dependencies: [{ service: "analytics", condition: "healthy" }],
            }),
            dependencyTimeoutSeconds: analyticsDependencyTimeoutSeconds,
            enabled: true,
          });
        }

        if (config.pooler !== false) {
          const poolerImage = yield* requirePreparedDockerImage(prepared, "pooler");
          defs.push({
            ...makePoolerServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: poolerImage,
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

        if (config.studio !== false) {
          const pgmetaConfig = config.pgmeta;
          const studioImage = yield* requirePreparedDockerImage(prepared, "studio");
          defs.push({
            ...makeStudioServiceDocker({
              runtime: yield* requireContainerRuntime,
              image: studioImage,
              identity,
              port: config.studio.port,
              apiUrl: config.studio.apiUrl,
              publicApiUrl: `http://127.0.0.1:${config.apiPort}`,
              pgmetaUrl: pgmetaConfig === false ? "" : `http://${serviceHost}:${pgmetaConfig.port}`,
              publishableKey: config.publishableKey,
              secretKey: config.secretKey,
              s3ProtocolAccessKeyId: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
              s3ProtocolAccessKeySecret: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
              jwtSecret: config.jwtSecret,
              analyticsEnabled: config.analytics !== false,
              analyticsBackend: config.analytics !== false ? config.analytics.backend : "postgres",
              analyticsUrl:
                config.analytics !== false ? `http://${serviceHost}:${config.analytics.port}` : "",
              analyticsApiKey: config.analytics !== false ? config.analytics.apiKey : "api-key",
              platformOs: platform.os,
              dependencies:
                config.analytics === false
                  ? [{ service: "pgmeta", condition: "healthy" }]
                  : [
                      { service: "pgmeta", condition: "healthy" },
                      { service: "analytics", condition: "healthy" },
                    ],
            }),
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

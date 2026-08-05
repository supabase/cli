import { buildGraph } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceDef } from "@supabase/process-compose";
import { Effect, Layer, Context } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { StackBuildError } from "./errors.ts";
import {
  detectPlatform,
  dockerHostAddress,
  dockerNetworkArgs,
  dockerPortMapArgs,
} from "./Platform.ts";
import { analyticsDockerRuntimeNetwork, makeAnalyticsServiceDocker } from "./services/analytics.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";
import {
  makeDatabaseSeedService,
  type DatabaseBootstrapRuntime,
} from "./services/database-bootstrap.ts";
import {
  makeEdgeRuntimeServiceDocker,
  makeEdgeRuntimeServiceNative,
} from "./services/edge-runtime.ts";
import { makeImgproxyServiceDocker } from "./services/imgproxy.ts";
import { mailpitContainerPorts, makeMailpitServiceDocker } from "./services/mailpit.ts";
import { makePgmetaServiceDocker } from "./services/pgmeta.ts";
import { makePoolerServiceDocker, poolerContainerPorts } from "./services/pooler.ts";
import { makePostgresInitService } from "./services/postgres-init.ts";
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
import type { PreparedStackArtifacts, ServiceResolution } from "./StackPreparation.ts";
import type { StackServiceProjectionCatalog } from "./StackStateProjection.ts";
import { SERVICE_NAMES, serviceMetadata } from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";
import type { VersionManifest } from "./versions.ts";

export interface BuildResult {
  readonly graph: ResolvedGraph;
  readonly cleanupTargets: CleanupTargets;
  readonly serviceProjection: StackServiceProjectionCatalog;
}

const dockerOnlyServices = SERVICE_NAMES.filter(
  (service) => serviceMetadata(service).runtimeSupport === "docker-only",
);

const dependsOnPostgres = (hasPostgresInit: boolean): ReadonlyArray<ServiceDependency> =>
  hasPostgresInit
    ? [{ service: "postgres-init", condition: "completed" }]
    : [{ service: "postgres", condition: "healthy" }];

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

  for (const name of ["postgres-init", "postgres-seed"]) {
    if (serviceProjection.has(name)) {
      serviceProjection.set(name, {
        visibility: "internal",
        owner: "postgres",
        ownerStatusWhileActive: "Initializing",
      });
    }
  }

  return serviceProjection;
};

const dockerContainerName = (service: string, apiPort: number) => `supabase-${service}-${apiPort}`;

const hasAutoManagedPath = (config: ResolvedStackConfig, path: string) =>
  config.autoManagedPaths.some(
    (managedPath) =>
      path === managedPath ||
      path.startsWith(`${managedPath}/`) ||
      path.startsWith(`${managedPath}\\`),
  );

const resolvedConfigForService = (config: ResolvedStackConfig, service: ServiceName) =>
  config[serviceMetadata(service).configKey];

export const validateResolvedConfig = (
  config: ResolvedStackConfig,
): Effect.Effect<void, StackBuildError> =>
  Effect.gen(function* () {
    if (config.mode === "native") {
      const enabledDockerOnly = dockerOnlyServices.filter(
        (service) => resolvedConfigForService(config, service) !== false,
      );
      if (enabledDockerOnly.length > 0) {
        return yield* Effect.fail(
          new StackBuildError({
            detail: `mode "native" only supports postgres, auth, and postgrest. Disable ${enabledDockerOnly.join(", ")} or switch to "auto" or "docker".`,
          }),
        );
      }
    }

    if (config.imgproxy !== false && config.storage === false) {
      return yield* Effect.fail(
        new StackBuildError({
          detail: "imgproxy requires storage to be enabled",
        }),
      );
    }

    if (config.vector !== false && config.analytics === false) {
      return yield* Effect.fail(
        new StackBuildError({
          detail: "vector requires analytics to be enabled",
        }),
      );
    }

    if (config.studio !== false && config.pgmeta === false) {
      return yield* Effect.fail(
        new StackBuildError({
          detail: "studio requires pgmeta to be enabled",
        }),
      );
    }
  });

export const enabledServicesForConfig = (config: ResolvedStackConfig): ReadonlyArray<ServiceName> =>
  SERVICE_NAMES.filter(
    (service) => service === "postgres" || resolvedConfigForService(config, service) !== false,
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

export const nativePostgresNeedsDockerAccess = (
  postgresResolution: ServiceResolution,
  dockerServicesEnabled: boolean,
): boolean => postgresResolution.type === "binary" && dockerServicesEnabled;

export class StackBuilder extends Context.Service<
  StackBuilder,
  {
    readonly build: (
      config: ResolvedStackConfig,
      prepared: PreparedStackArtifacts,
    ) => Effect.Effect<BuildResult, StackBuildError>;
  }
>()("local/StackBuilder") {
  static layer: Layer.Layer<StackBuilder> = Layer.succeed(this, {
    build: (config: ResolvedStackConfig, prepared: PreparedStackArtifacts) =>
      Effect.gen(function* () {
        yield* validateResolvedConfig(config);

        const platform = yield* detectPlatform;
        const serviceHost = dockerHostAddress(platform.os);
        const projectDir = config.projectDir;

        const postgresResolution = yield* requirePreparedResolution(prepared, "postgres");

        const authResolution =
          config.auth === false ? false : yield* requirePreparedResolution(prepared, "auth");

        const edgeRuntimeResolution =
          config.edgeRuntime === false
            ? false
            : yield* requirePreparedResolution(prepared, "edge-runtime");

        const postgrestResolution =
          config.postgrest === false
            ? false
            : yield* requirePreparedResolution(prepared, "postgrest");

        const dockerServicesEnabled =
          config.realtime !== false ||
          config.storage !== false ||
          config.imgproxy !== false ||
          config.mailpit !== false ||
          config.pgmeta !== false ||
          config.studio !== false ||
          config.analytics !== false ||
          config.vector !== false ||
          config.pooler !== false ||
          (edgeRuntimeResolution !== false && edgeRuntimeResolution.type === "docker") ||
          (authResolution !== false && authResolution.type === "docker") ||
          (postgrestResolution !== false && postgrestResolution.type === "docker");

        const needsDockerAccess = nativePostgresNeedsDockerAccess(
          postgresResolution,
          dockerServicesEnabled,
        );
        const hasPostgresInit = postgresResolution.type === "binary";
        const initialPostgresDeps = dependsOnPostgres(hasPostgresInit);
        const bootstrapRuntime: DatabaseBootstrapRuntime =
          postgresResolution.type === "binary"
            ? { _tag: "Native", postgresDir: postgresResolution.path }
            : {
                _tag: "Docker",
                containerName: dockerContainerName("postgres", config.apiPort),
              };
        const hasSeedPhase = config.databaseBootstrap.seedFiles.length > 0;
        const postgresDeps: ReadonlyArray<ServiceDependency> = hasSeedPhase
          ? [{ service: "postgres-seed", condition: "completed" }]
          : initialPostgresDeps;
        const jwtJwks = config.credentials.jwks;

        const defs: Array<ServiceDef & { enabled: boolean }> = [
          {
            ...(postgresResolution.type === "binary"
              ? makePostgresService({
                  binPath: postgresResolution.path,
                  dataDir: config.postgres.dataDir,
                  port: config.dbPort,
                  startupHealthTimeoutMs: config.postgres.startupHealthTimeoutMs,
                  dockerAccessible: needsDockerAccess,
                  cleanupDataDirOnExit: hasAutoManagedPath(config, config.postgres.dataDir),
                })
              : makePostgresServiceDocker({
                  image: postgresResolution.image,
                  dataDir: config.postgres.dataDir,
                  port: config.dbPort,
                  startupHealthTimeoutMs: config.postgres.startupHealthTimeoutMs,
                  networkArgs: dockerNetworkArgs(platform.os, [config.dbPort]),
                  jwtSecret: config.jwtSecret,
                  jwtExpiry: config.auth !== false ? config.auth.jwtExpiry : 3600,
                  apiPort: config.apiPort,
                  cleanupDataDirOnExit: hasAutoManagedPath(config, config.postgres.dataDir),
                })),
            enabled: true,
          },
        ];

        if (hasPostgresInit) {
          defs.push({
            ...makePostgresInitService({
              postgresDir: postgresResolution.path,
              dbPort: config.dbPort,
              autoExposeNewTables: config.postgres.autoExposeNewTables,
            }),
            enabled: true,
          });
        }

        if (hasSeedPhase) {
          defs.push({
            ...makeDatabaseSeedService({
              runtime: bootstrapRuntime,
              dbPort: config.dbPort,
              seedFiles: config.databaseBootstrap.seedFiles,
              dependencies: initialPostgresDeps,
            }),
            enabled: true,
          });
        }

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
                  dependencies: postgresDeps,
                })
              : makePostgrestServiceDocker({
                  image: postgrestResolution.image,
                  dbHost: serviceHost,
                  dbPort: config.dbPort,
                  port: config.postgrest.port,
                  adminPort: config.postgrest.adminPort,
                  schemas: config.postgrest.schemas,
                  extraSearchPath: config.postgrest.extraSearchPath,
                  maxRows: config.postgrest.maxRows,
                  jwtSecret: config.jwtSecret,
                  networkArgs: dockerNetworkArgs(platform.os, [
                    config.postgrest.port,
                    config.postgrest.adminPort,
                  ]),
                  apiPort: config.apiPort,
                  dependencies: postgresDeps,
                })),
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
                  config: config.auth,
                  signing: config.credentials.signing,
                  jwtSecret: config.jwtSecret,
                  smtpFallback:
                    config.mailpit === false
                      ? undefined
                      : {
                          host: "127.0.0.1",
                          port: config.mailpit.smtpTransportPort,
                          adminEmail: config.mailpit.adminEmail,
                          senderName: config.mailpit.senderName,
                        },
                  dependencies: postgresDeps,
                })
              : makeAuthServiceDocker({
                  image: authResolution.image,
                  dbHost: serviceHost,
                  dbPort: config.dbPort,
                  authPort: config.auth.port,
                  config: config.auth,
                  signing: config.credentials.signing,
                  jwtSecret: config.jwtSecret,
                  smtpFallback:
                    config.mailpit === false
                      ? undefined
                      : {
                          host: serviceHost,
                          port: config.mailpit.smtpTransportPort,
                          adminEmail: config.mailpit.adminEmail,
                          senderName: config.mailpit.senderName,
                        },
                  networkArgs: dockerNetworkArgs(platform.os, [config.auth.port]),
                  apiPort: config.apiPort,
                  dependencies: postgresDeps,
                })),
            enabled: true,
          });
        }

        if (config.edgeRuntime !== false && edgeRuntimeResolution !== false) {
          defs.push({
            ...(edgeRuntimeResolution.type === "binary"
              ? makeEdgeRuntimeServiceNative({
                  binPath: edgeRuntimeResolution.path,
                  runtimeRoot: config.runtimeRoot,
                  port: config.edgeRuntime.port,
                  inspectorPort: config.edgeRuntime.inspectorPort,
                  policy: config.edgeRuntime.policy,
                  env: config.edgeRuntime.env,
                  dependencies: postgresDeps,
                })
              : makeEdgeRuntimeServiceDocker({
                  image: edgeRuntimeResolution.image,
                  apiPort: config.apiPort,
                  runtimeRoot: config.runtimeRoot,
                  projectDir,
                  port: config.edgeRuntime.port,
                  inspectorPort: config.edgeRuntime.inspectorPort,
                  policy: config.edgeRuntime.policy,
                  env: config.edgeRuntime.env,
                  networkArgs: dockerNetworkArgs(platform.os, [config.edgeRuntime.port]),
                  dependencies: postgresDeps,
                })),
            enabled: true,
          });
        }

        if (config.mailpit !== false) {
          const mailpitImage = yield* requirePreparedDockerImage(prepared, "mailpit");
          defs.push({
            ...makeMailpitServiceDocker({
              image: mailpitImage,
              apiPort: config.apiPort,
              healthPort: config.mailpit.port,
              networkArgs: dockerPortMapArgs(platform.os, [
                { host: config.mailpit.port, container: mailpitContainerPorts.web },
                ...(config.mailpit.smtpHostPort === false
                  ? [
                      {
                        host: config.mailpit.smtpTransportPort,
                        container: mailpitContainerPorts.smtp,
                        hostAddress: "127.0.0.1",
                      },
                    ]
                  : [
                      {
                        host: config.mailpit.smtpHostPort,
                        container: mailpitContainerPorts.smtp,
                      },
                    ]),
                ...(config.mailpit.pop3HostPort === false
                  ? []
                  : [
                      {
                        host: config.mailpit.pop3HostPort,
                        container: mailpitContainerPorts.pop3,
                      },
                    ]),
              ]),
            }),
            enabled: true,
          });
        }

        if (config.realtime !== false) {
          const realtimeImage = yield* requirePreparedDockerImage(prepared, "realtime");
          defs.push({
            ...makeRealtimeServiceDocker({
              image: realtimeImage,
              port: config.realtime.port,
              apiPort: config.apiPort,
              dbHost: serviceHost,
              dbPort: config.dbPort,
              jwtSecret: config.jwtSecret,
              jwtJwks,
              tenantId: config.realtime.tenantId,
              encryptionKey: config.realtime.encryptionKey,
              secretKeyBase: config.realtime.secretKeyBase,
              maxHeaderLength: config.realtime.maxHeaderLength,
              ipVersion: config.realtime.ipVersion,
              networkArgs: dockerNetworkArgs(platform.os, [config.realtime.port]),
              dependencies: postgresDeps,
            }),
            enabled: true,
          });
        }

        if (config.storage !== false) {
          const storageImage = yield* requirePreparedDockerImage(prepared, "storage");
          defs.push({
            ...makeStorageServiceDocker({
              image: storageImage,
              port: config.storage.port,
              apiPort: config.apiPort,
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
              vectorRuntime: config.storage.vectorRuntime,
              networkArgs: dockerNetworkArgs(platform.os, [config.storage.port]),
              dependencies: postgresDeps,
              cleanupDataDirOnExit: hasAutoManagedPath(config, config.storage.dataDir),
            }),
            enabled: true,
          });
        }

        if (config.imgproxy !== false) {
          const storageConfig = config.storage;
          const imgproxyImage = yield* requirePreparedDockerImage(prepared, "imgproxy");
          defs.push({
            ...makeImgproxyServiceDocker({
              image: imgproxyImage,
              port: config.imgproxy.port,
              apiPort: config.apiPort,
              dataDir: storageConfig === false ? "" : storageConfig.dataDir,
              networkArgs: dockerNetworkArgs(platform.os, [config.imgproxy.port]),
              dependencies: [{ service: "storage", condition: "healthy" }],
            }),
            enabled: true,
          });
        }

        if (config.pgmeta !== false) {
          const pgmetaImage = yield* requirePreparedDockerImage(prepared, "pgmeta");
          defs.push({
            ...makePgmetaServiceDocker({
              image: pgmetaImage,
              apiPort: config.apiPort,
              port: config.pgmeta.port,
              dbHost: serviceHost,
              dbPort: config.dbPort,
              networkArgs: dockerNetworkArgs(platform.os, [config.pgmeta.port]),
              dependencies: postgresDeps,
            }),
            enabled: true,
          });
        }

        if (config.analytics !== false) {
          const analyticsImage = yield* requirePreparedDockerImage(prepared, "analytics");
          const analyticsRuntimeNetwork = analyticsDockerRuntimeNetwork(
            platform.os,
            config.analytics.port,
            serviceHost,
          );
          defs.push({
            ...makeAnalyticsServiceDocker({
              image: analyticsImage,
              apiPort: config.apiPort,
              hostPort: config.analytics.port,
              listenPort: analyticsRuntimeNetwork.listenPort,
              nodeHost: analyticsRuntimeNetwork.nodeHost,
              dbHost: serviceHost,
              dbPort: config.dbPort,
              apiKey: config.analytics.apiKey,
              backend: config.analytics.backend,
              gcp: config.analytics.gcp,
              networkArgs: dockerPortMapArgs(platform.os, [
                { host: config.analytics.port, container: 4000 },
              ]),
              dependencies: postgresDeps,
            }),
            enabled: true,
          });
        }

        if (config.vector !== false) {
          const analyticsConfig = config.analytics;
          const vectorImage = yield* requirePreparedDockerImage(prepared, "vector");
          defs.push({
            ...makeVectorServiceDocker({
              image: vectorImage,
              apiPort: config.apiPort,
              serviceHost,
              analyticsPort: analyticsConfig === false ? 0 : analyticsConfig.port,
              analyticsApiKey: analyticsConfig === false ? "api-key" : analyticsConfig.apiKey,
              networkArgs: dockerNetworkArgs(platform.os, []),
              dependencies: [{ service: "analytics", condition: "healthy" }],
            }),
            enabled: true,
          });
        }

        if (config.pooler !== false) {
          const poolerImage = yield* requirePreparedDockerImage(prepared, "pooler");
          defs.push({
            ...makePoolerServiceDocker({
              image: poolerImage,
              apiPort: config.apiPort,
              hostAdminPort: config.pooler.apiPort,
              dbHost: serviceHost,
              dbPort: config.dbPort,
              poolMode: config.pooler.mode,
              defaultPoolSize: config.pooler.defaultPoolSize,
              maxClientConn: config.pooler.maxClientConn,
              jwtSecret: config.jwtSecret,
              tenantId: config.pooler.tenantId,
              encryptionKey: config.pooler.encryptionKey,
              secretKeyBase: config.pooler.secretKeyBase,
              networkArgs: dockerPortMapArgs(platform.os, [
                {
                  host: config.pooler.apiPort,
                  container: poolerContainerPorts.admin,
                },
                {
                  host: config.pooler.port,
                  container:
                    config.pooler.mode === "session"
                      ? poolerContainerPorts.session
                      : poolerContainerPorts.transaction,
                },
              ]),
              dependencies: postgresDeps,
            }),
            enabled: true,
          });
        }

        if (config.studio !== false) {
          const pgmetaConfig = config.pgmeta;
          const studioImage = yield* requirePreparedDockerImage(prepared, "studio");
          defs.push({
            ...makeStudioServiceDocker({
              image: studioImage,
              apiPort: config.apiPort,
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
              openAiApiKey: config.studio.openAiApiKey,
              networkArgs: dockerNetworkArgs(platform.os, [config.studio.port]),
              dependencies:
                config.analytics === false
                  ? [{ service: "pgmeta", condition: "healthy" }]
                  : [
                      { service: "pgmeta", condition: "healthy" },
                      { service: "analytics", condition: "healthy" },
                    ],
            }),
            enabled: true,
          });
        }

        const dockerContainerNames = defs
          .filter((def) => def.command === "docker")
          .map((def) => dockerContainerName(def.name, config.apiPort));

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

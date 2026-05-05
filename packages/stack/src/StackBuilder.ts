import { buildGraph } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceDef } from "@supabase/process-compose";
import { Effect, Layer, ServiceMap } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { StackBuildError } from "./errors.ts";
import { generateJwks } from "./JwtGenerator.ts";
import {
  detectPlatform,
  dockerHostAddress,
  dockerNetworkArgs,
  dockerPortMapArgs,
} from "./Platform.ts";
import type { ServiceResolution } from "./resolve.ts";
import { makeAnalyticsServiceDocker } from "./services/analytics.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";
import {
  makeEdgeRuntimeServiceDocker,
  makeEdgeRuntimeServiceNative,
} from "./services/edge-runtime.ts";
import { makeImgproxyServiceDocker } from "./services/imgproxy.ts";
import { makeMailpitServiceDocker } from "./services/mailpit.ts";
import { makePgmetaServiceDocker } from "./services/pgmeta.ts";
import { makePoolerServiceDocker, poolerContainerPorts } from "./services/pooler.ts";
import { makePostgresInitService } from "./services/postgres-init.ts";
import { makePostgresService, makePostgresServiceDocker } from "./services/postgres.ts";
import { makePostgrestService, makePostgrestServiceDocker } from "./services/postgrest.ts";
import { makeRealtimeServiceDocker } from "./services/realtime.ts";
import { type ServiceDependency } from "./services/service-utils.ts";
import { makeStorageServiceDocker } from "./services/storage.ts";
import { makeStudioServiceDocker } from "./services/studio.ts";
import { makeVectorServiceDocker } from "./services/vector.ts";
import type { PreparedStackArtifacts } from "./StackPreparation.ts";
import type { StackServiceProjectionCatalog } from "./StackStateProjection.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import type { ServiceName, VersionManifest } from "./versions.ts";

export interface PostgresConfig {
  readonly port?: number;
  readonly dataDir?: string;
  readonly version?: string;
}

export interface PostgrestConfig {
  readonly schemas?: ReadonlyArray<string>;
  readonly extraSearchPath?: ReadonlyArray<string>;
  readonly maxRows?: number;
  readonly version?: string;
}

export interface AuthConfig {
  readonly port?: number;
  readonly siteUrl?: string;
  readonly jwtExpiry?: number;
  readonly externalUrl?: string;
  readonly version?: string;
}

export interface RealtimeConfig {
  readonly port?: number;
  readonly version?: string;
  readonly tenantId?: string;
  readonly encryptionKey?: string;
  readonly secretKeyBase?: string;
  readonly maxHeaderLength?: number;
}

export interface EdgeRuntimeConfig {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly inspectorPort?: number;
  readonly policy?: "oneshot" | "per_worker";
  readonly version?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StorageConfig {
  readonly port?: number;
  readonly dataDir?: string;
  readonly fileSizeLimit?: string;
  readonly s3ProtocolEnabled?: boolean;
  readonly version?: string;
}

export interface ImgproxyConfig {
  readonly port?: number;
  readonly version?: string;
}

export interface MailpitConfig {
  readonly port?: number;
  readonly smtpPort?: number;
  readonly pop3Port?: number;
  readonly version?: string;
  readonly adminEmail?: string;
  readonly senderName?: string;
}

export interface PgmetaConfig {
  readonly port?: number;
  readonly version?: string;
}

export interface StudioConfig {
  readonly port?: number;
  readonly apiUrl?: string;
  readonly version?: string;
}

export interface AnalyticsConfig {
  readonly port?: number;
  readonly version?: string;
  readonly backend?: "postgres" | "bigquery";
  readonly apiKey?: string;
}

export interface VectorConfig {
  readonly version?: string;
}

export interface PoolerConfig {
  readonly port?: number;
  readonly apiPort?: number;
  readonly mode?: "transaction" | "session";
  readonly version?: string;
  readonly tenantId?: string;
  readonly encryptionKey?: string;
  readonly secretKeyBase?: string;
  readonly defaultPoolSize?: number;
  readonly maxClientConn?: number;
}

export interface StackConfig {
  readonly cacheRoot?: string;
  readonly stackRoot?: string;
  readonly runtimeRoot?: string;
  readonly mode?: "native" | "auto" | "docker";
  readonly jwtSecret?: string;
  readonly port?: number;
  readonly publishableKey?: string;
  readonly secretKey?: string;
  readonly postgres?: PostgresConfig;
  readonly postgrest?: PostgrestConfig | false;
  readonly auth?: AuthConfig | false;
  readonly edgeRuntime?: EdgeRuntimeConfig | false;
  readonly realtime?: RealtimeConfig | false;
  readonly storage?: StorageConfig | false;
  readonly imgproxy?: ImgproxyConfig | false;
  readonly mailpit?: MailpitConfig | false;
  readonly pgmeta?: PgmetaConfig | false;
  readonly studio?: StudioConfig | false;
  readonly analytics?: AnalyticsConfig | false;
  readonly vector?: VectorConfig | false;
  readonly pooler?: PoolerConfig | false;
}

export interface ResolvedPostgresConfig {
  readonly port: number;
  readonly dataDir: string;
  readonly version: string;
}

export interface ResolvedPostgrestConfig {
  readonly port: number;
  readonly adminPort: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly version: string;
}

export interface ResolvedAuthConfig {
  readonly port: number;
  readonly siteUrl: string;
  readonly jwtExpiry: number;
  readonly externalUrl: string;
  readonly version: string;
}

export interface ResolvedRealtimeConfig {
  readonly port: number;
  readonly version: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly maxHeaderLength: number;
}

export interface ResolvedEdgeRuntimeConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly inspectorPort: number;
  readonly policy: "oneshot" | "per_worker";
  readonly version: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ResolvedStorageConfig {
  readonly port: number;
  readonly version: string;
  readonly dataDir: string;
  readonly fileSizeLimit: string;
  readonly s3ProtocolEnabled: boolean;
}

export interface ResolvedImgproxyConfig {
  readonly port: number;
  readonly version: string;
}

export interface ResolvedMailpitConfig {
  readonly port: number;
  readonly smtpPort: number;
  readonly pop3Port: number;
  readonly version: string;
  readonly adminEmail: string;
  readonly senderName: string;
}

export interface ResolvedPgmetaConfig {
  readonly port: number;
  readonly version: string;
}

export interface ResolvedStudioConfig {
  readonly port: number;
  readonly version: string;
  readonly apiUrl: string;
}

export interface ResolvedAnalyticsConfig {
  readonly port: number;
  readonly version: string;
  readonly backend: "postgres" | "bigquery";
  readonly apiKey: string;
}

export interface ResolvedVectorConfig {
  readonly version: string;
}

export interface ResolvedPoolerConfig {
  readonly port: number;
  readonly apiPort: number;
  readonly mode: "transaction" | "session";
  readonly version: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly defaultPoolSize: number;
  readonly maxClientConn: number;
}

export interface ResolvedStackConfig {
  readonly cacheRoot: string;
  readonly stackRoot: string;
  readonly runtimeRoot: string;
  readonly mode: "native" | "auto" | "docker";
  readonly jwtSecret: string;
  readonly ports: AllocatedPorts;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly autoManagedPaths: ReadonlyArray<string>;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly postgres: ResolvedPostgresConfig;
  readonly postgrest: ResolvedPostgrestConfig | false;
  readonly auth: ResolvedAuthConfig | false;
  readonly edgeRuntime: ResolvedEdgeRuntimeConfig | false;
  readonly realtime: ResolvedRealtimeConfig | false;
  readonly storage: ResolvedStorageConfig | false;
  readonly imgproxy: ResolvedImgproxyConfig | false;
  readonly mailpit: ResolvedMailpitConfig | false;
  readonly pgmeta: ResolvedPgmetaConfig | false;
  readonly studio: ResolvedStudioConfig | false;
  readonly analytics: ResolvedAnalyticsConfig | false;
  readonly vector: ResolvedVectorConfig | false;
  readonly pooler: ResolvedPoolerConfig | false;
}

export interface BuildResult {
  readonly graph: ResolvedGraph;
  readonly cleanupTargets: CleanupTargets;
  readonly serviceProjection: StackServiceProjectionCatalog;
}

const dockerOnlyServices = [
  "edge-runtime",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
] as const;

const dependsOnPostgres = (hasPostgresInit: boolean): ReadonlyArray<ServiceDependency> =>
  hasPostgresInit
    ? [{ service: "postgres-init", condition: "completed" }]
    : [{ service: "postgres", condition: "healthy" }];

const publicServiceProjection = (
  defs: ReadonlyArray<ServiceDef>,
  hasPostgresInit: boolean,
): StackServiceProjectionCatalog => {
  const serviceProjection: Map<
    string,
    {
      visibility: "public" | "internal";
      owner?: string;
      ownerStatusWhileActive?: "Initializing";
    }
  > = new Map(defs.map((def) => [def.name, { visibility: "public" as const }] as const));

  if (hasPostgresInit) {
    serviceProjection.set("postgres-init", {
      visibility: "internal",
      owner: "postgres",
      ownerStatusWhileActive: "Initializing",
    });
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

const resolvedConfigForService = (
  config: ResolvedStackConfig,
  service: Exclude<ServiceName, "postgres">,
) => (service === "edge-runtime" ? config.edgeRuntime : config[service]);

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

export const enabledServicesForConfig = (
  config: ResolvedStackConfig,
): ReadonlyArray<ServiceName> => {
  const services: ServiceName[] = ["postgres"];

  if (config.postgrest !== false) {
    services.push("postgrest");
  }
  if (config.auth !== false) {
    services.push("auth");
  }
  if (config.edgeRuntime !== false) {
    services.push("edge-runtime");
  }
  if (config.realtime !== false) {
    services.push("realtime");
  }
  if (config.storage !== false) {
    services.push("storage");
  }
  if (config.imgproxy !== false) {
    services.push("imgproxy");
  }
  if (config.mailpit !== false) {
    services.push("mailpit");
  }
  if (config.pgmeta !== false) {
    services.push("pgmeta");
  }
  if (config.studio !== false) {
    services.push("studio");
  }
  if (config.analytics !== false) {
    services.push("analytics");
  }
  if (config.vector !== false) {
    services.push("vector");
  }
  if (config.pooler !== false) {
    services.push("pooler");
  }

  return services;
};

export const versionsForConfig = (config: ResolvedStackConfig): Partial<VersionManifest> => ({
  postgres: config.postgres.version,
  ...(config.postgrest === false ? {} : { postgrest: config.postgrest.version }),
  ...(config.auth === false ? {} : { auth: config.auth.version }),
  ...(config.edgeRuntime === false ? {} : { "edge-runtime": config.edgeRuntime.version }),
  ...(config.realtime === false ? {} : { realtime: config.realtime.version }),
  ...(config.storage === false ? {} : { storage: config.storage.version }),
  ...(config.imgproxy === false ? {} : { imgproxy: config.imgproxy.version }),
  ...(config.mailpit === false ? {} : { mailpit: config.mailpit.version }),
  ...(config.pgmeta === false ? {} : { pgmeta: config.pgmeta.version }),
  ...(config.studio === false ? {} : { studio: config.studio.version }),
  ...(config.analytics === false ? {} : { analytics: config.analytics.version }),
  ...(config.vector === false ? {} : { vector: config.vector.version }),
  ...(config.pooler === false ? {} : { pooler: config.pooler.version }),
});

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

export class StackBuilder extends ServiceMap.Service<
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

        const needsDockerAccess =
          postgresResolution.type === "binary" && platform.os !== "linux" && dockerServicesEnabled;
        const hasPostgresInit = postgresResolution.type === "binary";
        const postgresDeps = dependsOnPostgres(hasPostgresInit);
        const jwtJwks = generateJwks(config.jwtSecret);

        const defs: Array<ServiceDef & { enabled: boolean }> = [
          {
            ...(postgresResolution.type === "binary"
              ? makePostgresService({
                  binPath: postgresResolution.path,
                  dataDir: config.postgres.dataDir,
                  port: config.dbPort,
                  dockerAccessible: needsDockerAccess,
                  cleanupDataDirOnExit: hasAutoManagedPath(config, config.postgres.dataDir),
                })
              : makePostgresServiceDocker({
                  image: postgresResolution.image,
                  dataDir: config.postgres.dataDir,
                  port: config.dbPort,
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
                })),
            ...(hasPostgresInit
              ? {}
              : {
                  dependencies: [{ service: "postgres", condition: "healthy" as const }],
                }),
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
                  dependencies: postgresDeps,
                })
              : makeAuthServiceDocker({
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
              webPort: config.mailpit.port,
              smtpPort: config.mailpit.smtpPort,
              pop3Port: config.mailpit.pop3Port,
              networkArgs: dockerNetworkArgs(platform.os, [
                config.mailpit.port,
                config.mailpit.smtpPort,
                config.mailpit.pop3Port,
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
          defs.push({
            ...makeAnalyticsServiceDocker({
              image: analyticsImage,
              apiPort: config.apiPort,
              hostPort: config.analytics.port,
              dbHost: serviceHost,
              dbPort: config.dbPort,
              apiKey: config.analytics.apiKey,
              backend: config.analytics.backend,
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
              jwtSecret: config.jwtSecret,
              analyticsEnabled: config.analytics !== false,
              analyticsBackend: config.analytics !== false ? config.analytics.backend : "postgres",
              analyticsUrl:
                config.analytics !== false ? `http://${serviceHost}:${config.analytics.port}` : "",
              analyticsApiKey: config.analytics !== false ? config.analytics.apiKey : "api-key",
              networkArgs: dockerNetworkArgs(platform.os, [config.studio.port]),
              dependencies: [{ service: "pgmeta", condition: "healthy" }],
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
          serviceProjection: publicServiceProjection(defs, hasPostgresInit),
        };
      }),
  });
}

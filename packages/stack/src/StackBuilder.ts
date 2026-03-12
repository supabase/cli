import { buildGraph } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceDef } from "@supabase/process-compose";
import { Effect, Layer, ServiceMap } from "effect";
import { BinaryResolver } from "./BinaryResolver.ts";
import { StackBuildError } from "./errors.ts";
import { generateJwks } from "./JwtGenerator.ts";
import {
  detectPlatform,
  dockerHostAddress,
  dockerNetworkArgs,
  dockerPortMapArgs,
} from "./Platform.ts";
import { type ServiceResolution, resolveService } from "./resolve.ts";
import { makeAnalyticsServiceDocker } from "./services/analytics.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";
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
import type { StackServiceProjectionCatalog } from "./StackStateProjection.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { dockerImageForService } from "./versions.ts";

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

interface BuildResult {
  readonly graph: ResolvedGraph;
  readonly dockerContainerNames: ReadonlyArray<string>;
  readonly serviceProjection: StackServiceProjectionCatalog;
}

const dockerOnlyServices = [
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

const validateResolvedConfig = (
  config: ResolvedStackConfig,
): Effect.Effect<void, StackBuildError> =>
  Effect.gen(function* () {
    if (config.mode === "native") {
      const enabledDockerOnly = dockerOnlyServices.filter((service) => config[service] !== false);
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

const resolveNativeCapableService = (
  resolver: BinaryResolver["Service"],
  mode: ResolvedStackConfig["mode"],
  service: "postgres" | "postgrest" | "auth",
  version: string,
): Effect.Effect<ServiceResolution, StackBuildError> =>
  mode === "docker"
    ? Effect.succeed({
        type: "docker" as const,
        image: dockerImageForService(service, version),
      })
    : mode === "native"
      ? resolver.resolve({ service, version }).pipe(
          Effect.map((path): ServiceResolution => ({ type: "binary", path })),
          Effect.mapError(
            (cause) =>
              new StackBuildError({
                detail: `Failed to resolve ${service} binary`,
                cause,
              }),
          ),
        )
      : resolveService(resolver, service, version).pipe(
          Effect.mapError(
            (cause) =>
              new StackBuildError({
                detail: `Failed to resolve ${service}`,
                cause,
              }),
          ),
        );

export class StackBuilder extends ServiceMap.Service<
  StackBuilder,
  {
    readonly build: (config: ResolvedStackConfig) => Effect.Effect<BuildResult, StackBuildError>;
  }
>()("local/StackBuilder") {
  static layer: Layer.Layer<StackBuilder, never, BinaryResolver> = Layer.effect(
    this,
    Effect.gen(function* () {
      const resolver = yield* BinaryResolver;

      return {
        build: (config) =>
          Effect.gen(function* () {
            yield* validateResolvedConfig(config);

            const platform = yield* detectPlatform;
            const serviceHost = dockerHostAddress(platform.os);

            const postgresResolution = yield* resolveNativeCapableService(
              resolver,
              config.mode,
              "postgres",
              config.postgres.version,
            );

            const authResolution =
              config.auth === false
                ? false
                : yield* resolveNativeCapableService(
                    resolver,
                    config.mode,
                    "auth",
                    config.auth.version,
                  );

            const postgrestResolution =
              config.postgrest === false
                ? false
                : yield* resolveNativeCapableService(
                    resolver,
                    config.mode,
                    "postgrest",
                    config.postgrest.version,
                  );

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
              (authResolution !== false && authResolution.type === "docker") ||
              (postgrestResolution !== false && postgrestResolution.type === "docker");

            const needsDockerAccess =
              postgresResolution.type === "binary" &&
              platform.os !== "linux" &&
              dockerServicesEnabled;
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
                      smtpAdminEmail:
                        config.mailpit !== false ? config.mailpit.adminEmail : undefined,
                      smtpSenderName:
                        config.mailpit !== false ? config.mailpit.senderName : undefined,
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
                      smtpAdminEmail:
                        config.mailpit !== false ? config.mailpit.adminEmail : undefined,
                      smtpSenderName:
                        config.mailpit !== false ? config.mailpit.senderName : undefined,
                      networkArgs: dockerNetworkArgs(platform.os, [config.auth.port]),
                      apiPort: config.apiPort,
                      dependencies: postgresDeps,
                    })),
                enabled: true,
              });
            }

            if (config.mailpit !== false) {
              defs.push({
                ...makeMailpitServiceDocker({
                  image: dockerImageForService("mailpit", config.mailpit.version),
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
              defs.push({
                ...makeRealtimeServiceDocker({
                  image: dockerImageForService("realtime", config.realtime.version),
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
              defs.push({
                ...makeStorageServiceDocker({
                  image: dockerImageForService("storage", config.storage.version),
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
                    config.imgproxy !== false
                      ? `http://${serviceHost}:${config.imgproxy.port}`
                      : "",
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
              defs.push({
                ...makeImgproxyServiceDocker({
                  image: dockerImageForService("imgproxy", config.imgproxy.version),
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
              defs.push({
                ...makePgmetaServiceDocker({
                  image: dockerImageForService("pgmeta", config.pgmeta.version),
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
              defs.push({
                ...makeAnalyticsServiceDocker({
                  image: dockerImageForService("analytics", config.analytics.version),
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
              defs.push({
                ...makeVectorServiceDocker({
                  image: dockerImageForService("vector", config.vector.version),
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
              defs.push({
                ...makePoolerServiceDocker({
                  image: dockerImageForService("pooler", config.pooler.version),
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
              defs.push({
                ...makeStudioServiceDocker({
                  image: dockerImageForService("studio", config.studio.version),
                  apiPort: config.apiPort,
                  port: config.studio.port,
                  apiUrl: config.studio.apiUrl,
                  publicApiUrl: `http://127.0.0.1:${config.apiPort}`,
                  pgmetaUrl:
                    pgmetaConfig === false ? "" : `http://${serviceHost}:${pgmetaConfig.port}`,
                  publishableKey: config.publishableKey,
                  secretKey: config.secretKey,
                  jwtSecret: config.jwtSecret,
                  analyticsEnabled: config.analytics !== false,
                  analyticsBackend:
                    config.analytics !== false ? config.analytics.backend : "postgres",
                  analyticsUrl:
                    config.analytics !== false
                      ? `http://${serviceHost}:${config.analytics.port}`
                      : "",
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
              dockerContainerNames,
              serviceProjection: publicServiceProjection(defs, hasPostgresInit),
            };
          }),
      };
    }),
  );
}

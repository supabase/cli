import { buildGraph } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceDef } from "@supabase/process-compose";
import { Effect, Layer, ServiceMap } from "effect";
import { BinaryResolver } from "./BinaryResolver.ts";
import { StackBuildError } from "./errors.ts";
import { detectPlatform, dockerHostAddress, dockerNetworkArgs } from "./Platform.ts";
import { type ServiceResolution, resolveService } from "./resolve.ts";
import { dockerImageForService } from "./versions.ts";
import { makeAuthServiceDocker, makeAuthServiceNative } from "./services/auth.ts";
import { makePostgresService, makePostgresServiceDocker } from "./services/postgres.ts";
import { makePostgresInitService } from "./services/postgres-init.ts";
import { makePostgrestService, makePostgrestServiceDocker } from "./services/postgrest.ts";

// -- User-facing per-service config types --

/** Postgres configuration. */
export interface PostgresConfig {
  /** Port to expose Postgres on. Auto-allocated if omitted. */
  readonly port?: number;
  /**
   * Directory for Postgres data files (PGDATA).
   * When omitted, an ephemeral temp dir is auto-created and cleaned up on dispose().
   * When provided, the directory is left intact on dispose().
   */
  readonly dataDir?: string;
  /** Postgres version. Defaults to DEFAULT_VERSIONS.postgres. */
  readonly version?: string;
}

/** PostgREST configuration. */
export interface PostgrestConfig {
  /** Schemas to expose via PostgREST. Defaults to ["public"]. */
  readonly schemas?: ReadonlyArray<string>;
  /** Extra search path for PostgREST. Defaults to ["public", "extensions"]. */
  readonly extraSearchPath?: ReadonlyArray<string>;
  /** Maximum number of rows PostgREST will return. Defaults to 1000. */
  readonly maxRows?: number;
  /** PostgREST version. Defaults to DEFAULT_VERSIONS.postgrest. */
  readonly version?: string;
}

/** Auth (GoTrue) configuration. */
export interface AuthConfig {
  /** Port for the auth service. Auto-allocated if omitted. */
  readonly port?: number;
  /** The site URL for auth redirects. Defaults to "http://localhost:3000". */
  readonly siteUrl?: string;
  /** JWT token expiry in seconds. Defaults to 3600. */
  readonly jwtExpiry?: number;
  /** External URL for auth callbacks. Defaults to http://127.0.0.1:${apiPort}. */
  readonly externalUrl?: string;
  /** Auth version. Defaults to DEFAULT_VERSIONS.auth. */
  readonly version?: string;
}

/**
 * User-facing stack configuration for createStack().
 *
 * Each service can be:
 * - An object: include the service with these settings
 * - `false`: explicitly exclude the service
 * - Omitted: include the service with default settings
 */
export interface StackConfig {
  /**
   * Override the default supabase home directory (~/.supabase).
   * Controls where stacks state and binary cache are stored.
   */
  readonly home?: string;

  /**
   * Resolution mode. `"auto"` (default) tries native binaries first, falls back to Docker.
   * `"docker"` uses Docker images for all services.
   */
  readonly mode?: "auto" | "docker";

  /** JWT secret shared across auth, PostgREST, and JWT generation. Defaults to a well-known dev secret. */
  readonly jwtSecret?: string;

  /** Public-facing API proxy port. Auto-allocated if omitted. */
  readonly port?: number;
  /** Publishable (anon) API key. Defaults to built-in dev key. */
  readonly publishableKey?: string;
  /** Secret (service_role) API key. Defaults to built-in dev key. */
  readonly secretKey?: string;

  /** Postgres configuration. When omitted, uses all defaults (ephemeral data dir). */
  readonly postgres?: PostgresConfig;
  /** PostgREST configuration. Set to false to exclude. */
  readonly postgrest?: PostgrestConfig | false;
  /** Auth (GoTrue) configuration. Set to false to exclude. */
  readonly auth?: AuthConfig | false;
}

// -- Internal resolved config types --

/** Resolved Postgres configuration — all values concrete. */
export interface ResolvedPostgresConfig {
  readonly port: number;
  readonly dataDir: string;
  readonly version: string;
}

/** Resolved PostgREST configuration — all values concrete. */
export interface ResolvedPostgrestConfig {
  readonly port: number;
  readonly adminPort: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly version: string;
}

/** Resolved Auth configuration — all values concrete. */
export interface ResolvedAuthConfig {
  readonly port: number;
  readonly siteUrl: string;
  readonly jwtExpiry: number;
  readonly externalUrl: string;
  readonly version: string;
}

/** Fully resolved stack configuration — all ports concrete, all defaults applied. */
export interface ResolvedStackConfig {
  /** Absolute path to supabase home directory. */
  readonly home: string;
  readonly mode: "auto" | "docker";
  readonly jwtSecret: string;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  /** When true, dataDir was auto-created and should be cleaned up on dispose(). */
  readonly autoManagedDataDir: boolean;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;

  readonly postgres: ResolvedPostgresConfig;
  readonly postgrest: ResolvedPostgrestConfig | false;
  readonly auth: ResolvedAuthConfig | false;
}

// -- Per-service builder helpers --

function buildPostgresDefs(
  postgresResolution: ServiceResolution,
  config: ResolvedStackConfig,
  needsDockerAccess: boolean,
  platformOs: string,
): Array<ServiceDef & { enabled: boolean }> {
  const defs: Array<ServiceDef & { enabled: boolean }> = [];

  defs.push({
    ...(postgresResolution.type === "binary"
      ? makePostgresService({
          binPath: postgresResolution.path,
          dataDir: config.postgres.dataDir,
          port: config.dbPort,
          dockerAccessible: needsDockerAccess,
          cleanupDataDirOnExit: config.autoManagedDataDir,
        })
      : makePostgresServiceDocker({
          image: postgresResolution.image,
          dataDir: config.postgres.dataDir,
          port: config.dbPort,
          networkArgs: dockerNetworkArgs(platformOs, [config.dbPort]),
          jwtSecret: config.jwtSecret,
          jwtExpiry: config.auth !== false ? config.auth.jwtExpiry : 3600,
          apiPort: config.apiPort,
          cleanupDataDirOnExit: config.autoManagedDataDir,
        })),
    enabled: true,
  });

  // postgres-init — one-shot migration service (native only)
  if (postgresResolution.type === "binary") {
    defs.push({
      ...makePostgresInitService({
        postgresDir: postgresResolution.path,
        dbPort: config.dbPort,
      }),
      enabled: true,
    });
  }

  return defs;
}

function buildPostgrestDefs(
  postgrestResolution: ServiceResolution,
  config: ResolvedStackConfig,
  hasPostgresInit: boolean,
  dbHost: string,
  platformOs: string,
): Array<ServiceDef & { enabled: boolean }> {
  if (config.postgrest === false) {
    return [];
  }

  const postgrestOpts = {
    dbPort: config.dbPort,
    port: config.postgrest.port,
    schemas: config.postgrest.schemas,
    extraSearchPath: config.postgrest.extraSearchPath,
    maxRows: config.postgrest.maxRows,
    jwtSecret: config.jwtSecret,
  };

  return [
    {
      ...(postgrestResolution.type === "binary"
        ? makePostgrestService({
            ...postgrestOpts,
            binPath: postgrestResolution.path,
          })
        : makePostgrestServiceDocker({
            ...postgrestOpts,
            image: postgrestResolution.image,
            dbHost,
            networkArgs: dockerNetworkArgs(platformOs, [config.postgrest.port]),
            adminPort: config.postgrest.adminPort,
            apiPort: config.apiPort,
          })),
      // When postgres-init exists, wait for it; otherwise fall back to postgres(healthy)
      ...(hasPostgresInit
        ? {}
        : { dependencies: [{ service: "postgres", condition: "healthy" as const }] }),
      enabled: true,
    },
  ];
}

function buildAuthDefs(
  authResolution: ServiceResolution,
  config: ResolvedStackConfig,
  hasPostgresInit: boolean,
  dbHost: string,
  platformOs: string,
): Array<ServiceDef & { enabled: boolean }> {
  if (config.auth === false) {
    return [];
  }

  const defs: Array<ServiceDef & { enabled: boolean }> = [];
  const authConfig = config.auth;
  const authOpts = {
    dbPort: config.dbPort,
    authPort: authConfig.port,
    siteUrl: authConfig.siteUrl,
    jwtSecret: config.jwtSecret,
    jwtExpiry: authConfig.jwtExpiry,
    externalUrl: authConfig.externalUrl,
    dependencies: hasPostgresInit
      ? ([{ service: "postgres-init", condition: "completed" }] as const)
      : ([{ service: "postgres", condition: "healthy" }] as const),
  };

  defs.push({
    ...(authResolution.type === "binary"
      ? makeAuthServiceNative({ ...authOpts, binPath: authResolution.path })
      : makeAuthServiceDocker({
          ...authOpts,
          image: authResolution.image,
          dbHost,
          networkArgs: dockerNetworkArgs(platformOs, [authConfig.port]),
          apiPort: config.apiPort,
        })),
    enabled: true,
  });

  return defs;
}

/** Result of building a stack — includes the service graph and Docker container names for cleanup. */
interface BuildResult {
  readonly graph: ResolvedGraph;
  readonly dockerContainerNames: ReadonlyArray<string>;
}

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
        build: (config: ResolvedStackConfig) =>
          Effect.gen(function* () {
            // 1. Detect platform
            const platform = yield* detectPlatform;
            const dbHost = dockerHostAddress(platform.os);

            // 2. Resolve all binaries (or use Docker directly in "docker" mode)
            const dockerMode = config.mode === "docker";

            const postgresResolution: ServiceResolution = dockerMode
              ? {
                  type: "docker",
                  image: dockerImageForService("postgres", config.postgres.version),
                }
              : yield* resolveService(resolver, "postgres", config.postgres.version).pipe(
                  Effect.mapError(
                    (e) =>
                      new StackBuildError({
                        detail: "Failed to resolve postgres",
                        cause: e,
                      }),
                  ),
                );

            let authResolution: ServiceResolution | false = false;
            if (config.auth !== false) {
              authResolution = dockerMode
                ? { type: "docker", image: dockerImageForService("auth", config.auth.version) }
                : yield* resolveService(resolver, "auth", config.auth.version).pipe(
                    Effect.mapError(
                      (e) =>
                        new StackBuildError({
                          detail: "Failed to resolve auth binary",
                          cause: e,
                        }),
                    ),
                  );
            }

            let postgrestResolution: ServiceResolution | false = false;
            if (config.postgrest !== false) {
              postgrestResolution = dockerMode
                ? {
                    type: "docker",
                    image: dockerImageForService("postgrest", config.postgrest.version),
                  }
                : yield* resolveService(resolver, "postgrest", config.postgrest.version).pipe(
                    Effect.mapError(
                      (e) =>
                        new StackBuildError({
                          detail: "Failed to resolve postgrest",
                          cause: e,
                        }),
                    ),
                  );
            }

            // 3. Determine flags
            // On macOS/Windows, Docker containers can't reach 127.0.0.1 on the host.
            // When native postgres serves Docker containers, it must listen on all interfaces.
            const hasDockerClient = authResolution !== false && authResolution.type === "docker";
            const needsDockerAccess =
              platform.os !== "linux" && postgresResolution.type === "binary" && hasDockerClient;
            const hasPostgresInit = postgresResolution.type === "binary";

            // 4. Build defs for each service via helpers
            const postgresDefs = buildPostgresDefs(
              postgresResolution,
              config,
              needsDockerAccess,
              platform.os,
            );

            const postgrestDefs =
              postgrestResolution !== false
                ? buildPostgrestDefs(
                    postgrestResolution,
                    config,
                    hasPostgresInit,
                    dbHost,
                    platform.os,
                  )
                : [];

            const authDefs =
              authResolution !== false
                ? buildAuthDefs(authResolution, config, hasPostgresInit, dbHost, platform.os)
                : [];

            // 5. Collect Docker container names for cleanup
            const dockerContainerNames: string[] = [];
            if (postgresResolution.type === "docker") {
              dockerContainerNames.push(`supa-postgres-${config.apiPort}`);
            }
            if (postgrestResolution !== false && postgrestResolution.type === "docker") {
              dockerContainerNames.push(`supa-postgrest-${config.apiPort}`);
            }
            if (authResolution !== false && authResolution.type === "docker") {
              dockerContainerNames.push(`supa-auth-${config.apiPort}`);
            }

            // 6. Concat all defs
            const allDefs = [...postgresDefs, ...postgrestDefs, ...authDefs];

            // 7. Build the dependency graph
            const graph = yield* buildGraph(allDefs).pipe(
              Effect.mapError(
                (e) =>
                  new StackBuildError({
                    detail: `Failed to build dependency graph`,
                    cause: e,
                  }),
              ),
            );

            return { graph, dockerContainerNames };
          }),
      };
    }),
  );
}

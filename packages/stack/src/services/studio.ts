import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface StudioServiceOptions {
  readonly port: number;
  readonly apiUrl: string;
  readonly publicApiUrl: string;
  readonly pgmetaUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly s3ProtocolAccessKeyId: string;
  readonly s3ProtocolAccessKeySecret: string;
  readonly jwtSecret: string;
  readonly analyticsEnabled: boolean;
  readonly analyticsBackend: "postgres" | "bigquery";
  readonly analyticsUrl: string;
  readonly analyticsApiKey: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeStudioOptions extends StudioServiceOptions {
  readonly binPath: string;
}

interface DockerStudioOptions extends StudioServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
}

const studioEnv = (opts: StudioServiceOptions): Record<string, string> => ({
  PORT: String(opts.port),
  CURRENT_CLI_VERSION: "local",
  STUDIO_PG_META_URL: opts.pgmetaUrl,
  POSTGRES_PASSWORD: "postgres",
  SUPABASE_URL: opts.apiUrl,
  SUPABASE_PUBLIC_URL: opts.publicApiUrl,
  AUTH_JWT_SECRET: opts.jwtSecret,
  SUPABASE_ANON_KEY: opts.publishableKey,
  SUPABASE_SERVICE_KEY: opts.secretKey,
  SUPABASE_PUBLISHABLE_KEY: opts.publishableKey,
  SUPABASE_SECRET_KEY: opts.secretKey,
  S3_PROTOCOL_ACCESS_KEY_ID: opts.s3ProtocolAccessKeyId,
  S3_PROTOCOL_ACCESS_KEY_SECRET: opts.s3ProtocolAccessKeySecret,
  LOGFLARE_PRIVATE_ACCESS_TOKEN: opts.analyticsApiKey,
  LOGFLARE_URL: opts.analyticsUrl,
  NEXT_PUBLIC_ENABLE_LOGS: String(opts.analyticsEnabled),
  NEXT_ANALYTICS_BACKEND_PROVIDER: opts.analyticsBackend,
  HOSTNAME: "0.0.0.0",
  POSTGRES_USER_READ_WRITE: "postgres",
  OPENAI_API_KEY: "",
  PGRST_DB_SCHEMAS: "public,graphql_public",
  PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
  PGRST_DB_MAX_ROWS: "1000",
});

const studioHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/api/platform/profile",
    scheme: "http",
  },
  ...stackHealthBudgets.studio,
});

export const makeStudioServiceDocker = (opts: DockerStudioOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "studio",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    env: studioEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: studioHealthCheck(opts.port),
  });

export const makeStudioServiceNative = (opts: NativeStudioOptions): ServiceDef =>
  nativeRunService({
    name: "studio",
    command: `${opts.binPath}/bin/studio`,
    env: studioEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: studioHealthCheck(opts.port),
  });

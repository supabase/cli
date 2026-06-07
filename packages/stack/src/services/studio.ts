import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";

interface DockerStudioOptions {
  readonly image: string;
  readonly apiPort: number;
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
  readonly networkArgs: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const studioHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/api/platform/profile",
    scheme: "http",
  },
  initialDelaySeconds: 2,
  periodSeconds: 1,
  failureThreshold: 60,
});

export const makeStudioServiceDocker = (opts: DockerStudioOptions): ServiceDef =>
  dockerRunService({
    name: "studio",
    containerName: `supabase-studio-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    env: {
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
    },
    dependsOn: opts.dependencies,
    healthCheck: studioHealthCheck(opts.port),
  });

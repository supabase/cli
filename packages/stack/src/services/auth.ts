import type { ServiceDef } from "@supabase/process-compose";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";

interface AuthServiceOptions {
  readonly dbPort: number;
  readonly authPort: number;
  readonly siteUrl: string;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly externalUrl: string;
  readonly dependencies: ReadonlyArray<{
    readonly service: string;
    readonly condition: "healthy" | "completed";
  }>;
}

interface NativeAuthOptions extends AuthServiceOptions {
  readonly binPath: string;
}

interface DockerAuthOptions extends AuthServiceOptions {
  readonly image: string;
  readonly dbHost: string;
  readonly networkArgs: readonly string[];
  readonly apiPort: number;
}

const authEnv = (opts: AuthServiceOptions, dbHost = "127.0.0.1"): Record<string, string> => ({
  GOTRUE_DB_DATABASE_URL: `postgresql://supabase_auth_admin:postgres@${dbHost}:${opts.dbPort}/postgres`,
  GOTRUE_DB_DRIVER: "postgres",
  GOTRUE_SITE_URL: opts.siteUrl,
  GOTRUE_JWT_SECRET: opts.jwtSecret,
  GOTRUE_JWT_EXP: String(opts.jwtExpiry),
  GOTRUE_JWT_AUD: "authenticated",
  GOTRUE_JWT_ADMIN_ROLES: "service_role",
  GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
  API_EXTERNAL_URL: opts.externalUrl,
  GOTRUE_API_HOST: "0.0.0.0",
  GOTRUE_API_PORT: String(opts.authPort),
  GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
  GOTRUE_MAILER_AUTOCONFIRM: "true",
  GOTRUE_DISABLE_SIGNUP: "false",
});

const authHealthCheck = (port: number) => ({
  probe: {
    _tag: "Http" as const,
    host: "127.0.0.1",
    port,
    path: "/health",
    scheme: "http" as const,
  },
  periodSeconds: 0.5,
  failureThreshold: 20,
});

export const makeAuthServiceNative = (opts: NativeAuthOptions): ServiceDef => ({
  name: "auth",
  command: `${opts.binPath}/auth`,
  env: authEnv(opts),
  dependencies: opts.dependencies,
  healthCheck: authHealthCheck(opts.authPort),
  supervision: {},
  restart: "unless-stopped",
});

export const makeAuthServiceDocker = (opts: DockerAuthOptions): ServiceDef => {
  const env = authEnv(opts, opts.dbHost);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const containerName = `supabase-auth-${opts.apiPort}`;

  return {
    name: "auth",
    command: "docker",
    args: ["run", "--rm", "--name", containerName, ...opts.networkArgs, ...envArgs, opts.image],
    dependencies: opts.dependencies,
    healthCheck: authHealthCheck(opts.authPort),
    cleanup: dockerServiceCleanup(containerName),
    supervision: { orphanCleanup: dockerServiceOrphanCleanup(containerName) },
    restart: "unless-stopped",
  };
};

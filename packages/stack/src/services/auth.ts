import type { ServiceDef } from "@supabase/process-compose";
import type { AuthExternalProviderConfig } from "../StackBuilder.ts";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";

interface AuthServiceOptions {
  readonly dbPort: number;
  readonly authPort: number;
  readonly siteUrl: string;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  /** The auth service's public URL through the API gateway, path
   * included (`<api-root>/auth/v1`) — the classic CLI's
   * auth.external_url. Emitted as API_EXTERNAL_URL (GoTrue builds
   * outgoing URLs against it) and the base for the derived provider
   * callback. */
  readonly externalUrl: string;
  readonly smtpHost?: string;
  readonly smtpPort?: number;
  readonly smtpAdminEmail?: string;
  readonly smtpSenderName?: string;
  /** External OAuth providers by GoTrue provider id, translated to
   * `GOTRUE_EXTERNAL_<ID>_*` env the way the classic CLI translates
   * `[auth.external.*]`. */
  readonly external?: Readonly<Record<string, AuthExternalProviderConfig>>;
  /** Extra allowed redirect targets, translated to GOTRUE_URI_ALLOW_LIST
   * like the classic CLI's [auth] additional_redirect_urls. */
  readonly additionalRedirectUrls?: ReadonlyArray<string>;
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

/** Mirrors the classic CLI's [auth.external.*] → GOTRUE_EXTERNAL_* env
 * translation. Every field emits explicitly, defaults included:
 * native-mode spawns extend the parent environment, so an unset
 * variable would inherit whatever the shell carries — the classic CLI
 * shadows the same way (start.go emits the booleans with %t). The
 * empty string is the classic surface's unset (TOML strings can't be
 * absent; the generated template ships redirect_uri = "" and
 * url = ""), so an empty redirectUri falls back to the derived
 * callback like start.go. url emits even when empty — GoTrue reads an
 * empty URL as unset (chooseHost falls back to each provider's
 * default), so this matches start.go's skip-when-empty behaviorally
 * while still shadowing the parent env; start.go can afford to skip
 * because its containers never inherit a shell. */
const externalProviderEnv = (opts: AuthServiceOptions): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [id, provider] of Object.entries(opts.external ?? {})) {
    const prefix = `GOTRUE_EXTERNAL_${id.toUpperCase()}`;
    env[`${prefix}_ENABLED`] = String(provider.enabled ?? true);
    env[`${prefix}_CLIENT_ID`] = provider.clientId;
    env[`${prefix}_SECRET`] = provider.secret ?? "";
    env[`${prefix}_REDIRECT_URI`] = provider.redirectUri || `${opts.externalUrl}/callback`;
    env[`${prefix}_SKIP_NONCE_CHECK`] = String(provider.skipNonceCheck ?? false);
    env[`${prefix}_EMAIL_OPTIONAL`] = String(provider.emailOptional ?? false);
    env[`${prefix}_URL`] = provider.url ?? "";
  }
  return env;
};

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
  ...(opts.smtpHost === undefined
    ? {}
    : {
        GOTRUE_SMTP_HOST: opts.smtpHost,
        GOTRUE_SMTP_PORT: String(opts.smtpPort ?? 1025),
        ...(opts.smtpAdminEmail === undefined
          ? {}
          : { GOTRUE_SMTP_ADMIN_EMAIL: opts.smtpAdminEmail }),
        ...(opts.smtpSenderName === undefined
          ? {}
          : { GOTRUE_SMTP_SENDER_NAME: opts.smtpSenderName }),
      }),
  // Always emitted, empty when none: native spawns extend the parent env,
  // so omission would let a shell GOTRUE_URI_ALLOW_LIST become the allow
  // list (start.go always appends it, empty included).
  GOTRUE_URI_ALLOW_LIST: (opts.additionalRedirectUrls ?? []).join(","),
  ...externalProviderEnv(opts),
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

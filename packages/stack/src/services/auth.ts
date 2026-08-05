import type { ServiceDef } from "@supabase/process-compose";
import type { AuthEnvironmentInput, ResolvedAuthRuntimeConfig } from "../AuthConfig.ts";
import { authSigningKeysJson } from "../LocalCredentials.ts";
import type { LocalJwtSigningMaterial } from "../LocalCredentials.ts";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface AuthServiceOptions {
  readonly dbPort: number;
  readonly authPort: number;
  readonly config: ResolvedAuthRuntimeConfig;
  readonly signing: LocalJwtSigningMaterial;
  readonly jwtSecret: string;
  readonly smtpFallback?: AuthEnvironmentInput["smtpFallback"];
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

const passwordRequirements: Readonly<Record<string, string>> = {
  letters_digits: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits_symbols:
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
};

function formatMap(input: Readonly<Record<string, string>> | undefined): string {
  return input === undefined
    ? ""
    : Object.entries(input)
        .map(([key, value]) => `${key}:${value}`)
        .join(",");
}

function appendSmsProvider(env: Record<string, string>, config: ResolvedAuthRuntimeConfig): void {
  const provider = config.sms.provider;
  if (provider === undefined) return;

  switch (provider._tag) {
    case "twilio":
      env["GOTRUE_SMS_PROVIDER"] = "twilio";
      env["GOTRUE_SMS_TWILIO_ACCOUNT_SID"] = provider.accountSid;
      env["GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID"] = provider.messageServiceSid;
      env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"] = provider.authToken;
      return;
    case "twilio-verify":
      env["GOTRUE_SMS_PROVIDER"] = "twilio_verify";
      env["GOTRUE_SMS_TWILIO_VERIFY_ACCOUNT_SID"] = provider.accountSid;
      env["GOTRUE_SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID"] = provider.messageServiceSid;
      env["GOTRUE_SMS_TWILIO_VERIFY_AUTH_TOKEN"] = provider.authToken;
      return;
    case "messagebird":
      env["GOTRUE_SMS_PROVIDER"] = "messagebird";
      env["GOTRUE_SMS_MESSAGEBIRD_ORIGINATOR"] = provider.originator;
      env["GOTRUE_SMS_MESSAGEBIRD_ACCESS_KEY"] = provider.accessKey;
      return;
    case "textlocal":
      env["GOTRUE_SMS_PROVIDER"] = "textlocal";
      env["GOTRUE_SMS_TEXTLOCAL_SENDER"] = provider.sender;
      env["GOTRUE_SMS_TEXTLOCAL_API_KEY"] = provider.apiKey;
      return;
    case "vonage":
      env["GOTRUE_SMS_PROVIDER"] = "vonage";
      env["GOTRUE_SMS_VONAGE_FROM"] = provider.from;
      env["GOTRUE_SMS_VONAGE_API_KEY"] = provider.apiKey;
      env["GOTRUE_SMS_VONAGE_API_SECRET"] = provider.apiSecret;
      return;
  }
}

function appendExternalProviders(
  env: Record<string, string>,
  config: ResolvedAuthRuntimeConfig,
): void {
  for (const [name, provider] of Object.entries(config.externalProviders)) {
    const prefix = `GOTRUE_EXTERNAL_${name.toUpperCase()}`;
    env[`${prefix}_ENABLED`] = String(provider.enabled);
    env[`${prefix}_CLIENT_ID`] = provider.clientId;
    env[`${prefix}_SECRET`] = provider.secret ?? "";
    env[`${prefix}_SKIP_NONCE_CHECK`] = String(provider.skipNonceCheck);
    env[`${prefix}_EMAIL_OPTIONAL`] = String(provider.emailOptional);
    env[`${prefix}_REDIRECT_URI`] =
      provider.redirectUri === undefined || provider.redirectUri.length === 0
        ? `${config.jwtIssuer}/callback`
        : provider.redirectUri;
    if (provider.url.length > 0) env[`${prefix}_URL`] = provider.url;
  }
}

function appendHooks(env: Record<string, string>, config: ResolvedAuthRuntimeConfig): void {
  for (const [name, hook] of Object.entries(config.hooks)) {
    if (!hook.enabled) continue;
    const prefix = `GOTRUE_HOOK_${name.toUpperCase()}`;
    env[`${prefix}_ENABLED`] = "true";
    env[`${prefix}_URI`] = hook.uri ?? "";
    env[`${prefix}_SECRETS`] = hook.secrets ?? "";
  }
}

function makeAuthEnvironment(input: AuthEnvironmentInput): Record<string, string> {
  const { config } = input;
  const mailerVerifyUrl = `${config.externalUrl.replace(/\/+$/, "")}/verify`;
  const env: Record<string, string> = {
    GOTRUE_DB_DATABASE_URL: `postgresql://supabase_auth_admin:postgres@${input.dbHost}:${input.dbPort}/postgres`,
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_SITE_URL: config.siteUrl,
    GOTRUE_URI_ALLOW_LIST: config.additionalRedirectUrls.join(","),
    GOTRUE_JWT_SECRET: input.jwtSecret,
    GOTRUE_JWT_EXP: String(config.jwtExpiry),
    GOTRUE_JWT_ISSUER: config.jwtIssuer,
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    API_EXTERNAL_URL: config.externalUrl,
    GOTRUE_API_HOST: "0.0.0.0",
    GOTRUE_API_PORT: String(config.port),
    GOTRUE_DISABLE_SIGNUP: String(!config.enableSignup),
    GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: String(config.enableAnonymousSignIns),
    GOTRUE_EXTERNAL_EMAIL_ENABLED: String(config.email.enableSignup),
    GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: String(config.email.doubleConfirmChanges),
    GOTRUE_MAILER_AUTOCONFIRM: String(!config.email.enableConfirmations),
    GOTRUE_MAILER_OTP_LENGTH: String(config.email.otpLength),
    GOTRUE_MAILER_OTP_EXP: String(config.email.otpExpiry),
    GOTRUE_SMTP_MAX_FREQUENCY: config.email.maxFrequency,
    GOTRUE_MAILER_URLPATHS_INVITE: mailerVerifyUrl,
    GOTRUE_MAILER_URLPATHS_CONFIRMATION: mailerVerifyUrl,
    GOTRUE_MAILER_URLPATHS_RECOVERY: mailerVerifyUrl,
    GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: mailerVerifyUrl,
    GOTRUE_EXTERNAL_PHONE_ENABLED: String(config.sms.enableSignup),
    GOTRUE_SMS_AUTOCONFIRM: String(!config.sms.enableConfirmations),
    GOTRUE_SMS_MAX_FREQUENCY: config.sms.maxFrequency,
    GOTRUE_SMS_OTP_EXP: "6000",
    GOTRUE_SMS_OTP_LENGTH: "6",
    GOTRUE_SMS_TEMPLATE: config.sms.template,
    GOTRUE_SMS_TEST_OTP: formatMap(config.sms.testOtp),
    GOTRUE_PASSWORD_MIN_LENGTH: String(config.minimumPasswordLength),
    GOTRUE_PASSWORD_REQUIRED_CHARACTERS: passwordRequirements[config.passwordRequirements] ?? "",
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: String(config.enableRefreshTokenRotation),
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: String(config.refreshTokenReuseInterval),
    GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: String(config.enableManualLinking),
    GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: String(
      config.email.securePasswordChange,
    ),
  };

  const signingKeys = authSigningKeysJson(input.signing);
  if (signingKeys !== undefined) {
    env["GOTRUE_JWT_KEYS"] = signingKeys;
    env["GOTRUE_JWT_VALIDMETHODS"] = "HS256,RS256,ES256";
    env["GOTRUE_JWT_VALID_METHODS"] = "HS256,RS256,ES256";
  }

  const smtp = config.email.smtp ?? input.smtpFallback;
  if (smtp !== undefined) {
    env["GOTRUE_SMTP_HOST"] = smtp.host;
    env["GOTRUE_SMTP_PORT"] = String(smtp.port);
    env["GOTRUE_SMTP_ADMIN_EMAIL"] = smtp.adminEmail;
    env["GOTRUE_SMTP_SENDER_NAME"] = smtp.senderName ?? "";
    if ("user" in smtp) {
      env["GOTRUE_SMTP_USER"] = smtp.user;
      env["GOTRUE_SMTP_PASS"] = smtp.pass;
    }
  }

  appendSmsProvider(env, config);
  appendExternalProviders(env, config);
  appendHooks(env, config);
  return env;
}

const authHealthCheck = (port: number): NonNullable<ServiceDef["healthCheck"]> => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/health",
    scheme: "http",
  },
  ...stackHealthBudgets.auth,
});

export const makeAuthServiceNative = (opts: NativeAuthOptions): ServiceDef => ({
  name: "auth",
  command: `${opts.binPath}/auth`,
  env: makeAuthEnvironment({
    config: opts.config,
    signing: opts.signing,
    jwtSecret: opts.jwtSecret,
    dbHost: "127.0.0.1",
    dbPort: opts.dbPort,
    smtpFallback: opts.smtpFallback,
  }),
  dependencies: opts.dependencies,
  healthCheck: authHealthCheck(opts.authPort),
  supervision: {},
  restart: "unless-stopped",
});

export const makeAuthServiceDocker = (opts: DockerAuthOptions): ServiceDef => {
  const env = makeAuthEnvironment({
    config: opts.config,
    signing: opts.signing,
    jwtSecret: opts.jwtSecret,
    dbHost: opts.dbHost,
    dbPort: opts.dbPort,
    smtpFallback: opts.smtpFallback,
  });
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

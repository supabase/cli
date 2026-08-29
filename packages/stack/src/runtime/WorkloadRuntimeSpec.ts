import type { PersistedStackState } from "../state/StackState.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { ContainerMount } from "./ContainerEngine.ts";

export type WorkloadRuntimeKind = "native" | "container";

/** Complete process-side contract for one catalog workload. */
export interface WorkloadRuntimeSpec {
  readonly containerPort: number;
  readonly cwd: (state: PersistedStackState, workload: PlannedWorkload) => string;
  readonly privateEndpoint: (
    port: number,
    runtime?: WorkloadRuntimeKind,
  ) => Readonly<{ readonly host: string; readonly port: number }>;
  readonly args: (
    state: PersistedStackState,
    workload: PlannedWorkload,
    port: number,
    runtime?: WorkloadRuntimeKind,
  ) => ReadonlyArray<string>;
  readonly env: (
    state: PersistedStackState,
    workload: PlannedWorkload,
    port: number,
    runtime?: WorkloadRuntimeKind,
  ) => Readonly<Record<string, string>>;
  readonly containerArgs: (
    state: PersistedStackState,
    workload: PlannedWorkload,
    port: number,
  ) => ReadonlyArray<string>;
  readonly containerMounts?: (
    state: PersistedStackState,
    workload: PlannedWorkload,
  ) => ReadonlyArray<ContainerMount>;
  readonly networkAliases?: ReadonlyArray<string>;
  readonly readiness: Readonly<{ readonly protocol: "http" | "tcp"; readonly path?: string }>;
}

type WorkloadRuntimeSpecDefinition = Omit<WorkloadRuntimeSpec, "cwd" | "privateEndpoint"> &
  Partial<Pick<WorkloadRuntimeSpec, "cwd" | "privateEndpoint">>;

export interface ContainerWorkloadResolution {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: ReadonlyArray<ContainerMount>;
  readonly networkAliases: ReadonlyArray<string>;
}

export const FUNCTIONS_CONTAINER_ROOT = "/__supabase_functions";
const DATABASE_NETWORK_ALIAS = "supabase-database";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const settingsFor = (state: PersistedStackState, capability: CapabilityName): unknown =>
  state.definition === undefined ? undefined : state.definition.capabilities[capability].settings;

const secret = (state: PersistedStackState, slot: string): string =>
  state.secrets[slot]?.value ?? "";

const settingValue = (state: PersistedStackState, value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map((entry) => settingValue(state, entry)).join(",");
  if (isRecord(value) && typeof value.slot === "string" && Object.keys(value).length === 1)
    return secret(state, value.slot);
  return JSON.stringify(value) ?? "";
};

/** Flatten all materialized settings so no capability field silently disappears at runtime. */
const flattenSettings = (
  state: PersistedStackState,
  value: unknown,
  prefix: string,
  out: Record<string, string>,
): void => {
  if (value === null || value === undefined) return;
  if (isRecord(value) && typeof value.slot === "string" && Object.keys(value).length === 1) {
    out[prefix] = secret(state, value.slot);
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = value.map((entry) => settingValue(state, entry)).join(",");
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
      flattenSettings(
        state,
        entry,
        prefix.length === 0 ? normalized : `${prefix}_${normalized}`,
        out,
      );
    }
    return;
  }
  out[prefix] = settingValue(state, value);
};

const capabilityEnv = (
  state: PersistedStackState,
  capability: CapabilityName,
  prefix: string,
): Record<string, string> => {
  const out: Record<string, string> = {};
  const settings = settingsFor(state, capability);
  if (settings !== undefined) flattenSettings(state, settings, prefix, out);
  return out;
};

const valueAt = (state: PersistedStackState, capability: CapabilityName, path: string): string => {
  let current: unknown = settingsFor(state, capability);
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return "";
    current = current[segment];
  }
  return settingValue(state, current);
};

const dbPort = (state: PersistedStackState): number =>
  state.ports.find((assignment) => assignment.field === "database")?.port ?? 5432;

const dbHost = (runtime: WorkloadRuntimeKind): string =>
  runtime === "container" ? DATABASE_NETWORK_ALIAS : "127.0.0.1";

const dbUrl = (state: PersistedStackState, role: string, runtime: WorkloadRuntimeKind): string => {
  const port = runtime === "container" ? 5432 : dbPort(state);
  return `postgresql://${role}:${secret(state, "secret:database.internal.password")}@${dbHost(runtime)}:${port}/postgres`;
};

const common = (workload: PlannedWorkload, port: number): Record<string, string> => ({
  SUPABASE_STACK_WORKLOAD: workload.id,
  SUPABASE_STACK_PRIVATE_PORT: String(port),
});

const functionsRoot = (state: PersistedStackState): string =>
  valueAt(state, "functions", "functions_root") ||
  `${state.identity.projectRoot}/supabase/functions`;

const privateEndpointFor = (
  port: number,
  runtime: WorkloadRuntimeKind = "native",
  alias = "supabase-workload",
): Readonly<{ readonly host: string; readonly port: number }> => ({
  host: runtime === "container" ? alias : "127.0.0.1",
  port,
});

const withRestSettings = (
  state: PersistedStackState,
  runtime: WorkloadRuntimeKind,
  port: number,
  workload: PlannedWorkload,
): Record<string, string> => ({
  ...common(workload, port),
  ...capabilityEnv(state, "rest", "PGRST"),
  PGRST_DB_URI: dbUrl(state, "authenticator", runtime),
  PGRST_DB_SCHEMAS: valueAt(state, "rest", "schemas") || "public,graphql_public",
  PGRST_DB_EXTRA_SEARCH_PATH: valueAt(state, "rest", "extra_search_path") || "public,extensions",
  PGRST_DB_ANON_ROLE: "anon",
  PGRST_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
  PGRST_SERVER_PORT: String(port),
  PGRST_DB_MAX_ROWS: valueAt(state, "rest", "max_rows") || "1000",
});

const authNestedEnvironment = (state: PersistedStackState): Record<string, string> => {
  const out: Record<string, string> = {};
  const settings = settingsFor(state, "auth");
  if (!isRecord(settings)) return out;
  const external = settings.external;
  if (isRecord(external))
    for (const [provider, value] of Object.entries(external)) {
      if (!isRecord(value)) continue;
      const prefix = `GOTRUE_EXTERNAL_${provider.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`;
      for (const [key, entry] of Object.entries(value))
        out[`${prefix}_${key.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`] = settingValue(
          state,
          entry,
        );
      const configuredRedirect = settingValue(state, value.redirect_uri);
      out[`${prefix}_REDIRECT_URI`] = configuredRedirect || `${authExternalUrl(state)}/callback`;
    }
  const hooks = settings.hook;
  if (isRecord(hooks))
    for (const [hook, value] of Object.entries(hooks)) {
      if (!isRecord(value)) continue;
      if (value.enabled !== true) continue;
      const prefix = `GOTRUE_HOOK_${hook.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`;
      for (const [key, entry] of Object.entries(value))
        out[`${prefix}_${key.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`] = settingValue(
          state,
          entry,
        );
    }
  const email = settings.email;
  if (isRecord(email)) {
    const templates = email.template;
    if (isRecord(templates))
      for (const [name, value] of Object.entries(templates)) {
        if (!isRecord(value)) continue;
        const normalized = name.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
        const subject = settingValue(state, value.subject);
        const contentPath = settingValue(state, value.content_path);
        if (value.subject !== null && value.subject !== undefined)
          out[`GOTRUE_MAILER_SUBJECTS_${normalized}`] = subject;
        if (contentPath.length > 0) out[`GOTRUE_MAILER_TEMPLATES_${normalized}`] = contentPath;
      }
    const notifications = email.notification;
    if (isRecord(notifications))
      for (const [name, value] of Object.entries(notifications)) {
        if (!isRecord(value)) continue;
        if (value.enabled !== true) continue;
        const normalized = name.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
        out[`GOTRUE_MAILER_NOTIFICATIONS_${normalized}_ENABLED`] = settingValue(
          state,
          value.enabled,
        );
        out[`GOTRUE_MAILER_NOTIFICATIONS_${normalized}_SUBJECT`] = settingValue(
          state,
          value.subject,
        );
      }
  }
  return out;
};

const authExternalUrl = (state: PersistedStackState): string => {
  const apiPort = state.ports.find((assignment) => assignment.field === "api")?.port;
  return `http://127.0.0.1${apiPort === undefined ? "" : `:${apiPort}`}/auth/v1`;
};

const authSmsProvider = (state: PersistedStackState): string => {
  const sms = settingsFor(state, "auth");
  if (!isRecord(sms) || !isRecord(sms.sms)) return "";
  const providers = ["twilio_verify", "twilio", "messagebird", "textlocal", "vonage"];
  for (const provider of providers) {
    const value = sms.sms[provider];
    if (isRecord(value) && value.enabled === true) return provider;
  }
  return "";
};

const authSmsTestOtp = (state: PersistedStackState): string => {
  const value = valueAt(state, "auth", "sms.test_otp");
  if (value.length === 0) return "";
  const settings = settingsFor(state, "auth");
  if (!isRecord(settings) || !isRecord(settings.sms) || !isRecord(settings.sms.test_otp)) return "";
  return Object.entries(settings.sms.test_otp)
    .map(([phone, otp]) => `${phone}:${settingValue(state, otp)}`)
    .join(",");
};

const passwordRequiredCharacters = (state: PersistedStackState): string => {
  const requirements = valueAt(state, "auth", "password_requirements");
  if (requirements === "letters_digits")
    return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789";
  if (requirements === "lower_upper_letters_digits")
    return "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789";
  if (requirements === "lower_upper_letters_digits_symbols")
    return "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\":|<>?,./`~";
  return "";
};

const withAuthSettings = (
  state: PersistedStackState,
  runtime: WorkloadRuntimeKind,
  port: number,
  workload: PlannedWorkload,
): Record<string, string> => ({
  ...common(workload, port),
  ...capabilityEnv(state, "auth", "GOTRUE"),
  ...authNestedEnvironment(state),
  GOTRUE_DB_DATABASE_URL: dbUrl(state, "supabase_auth_admin", runtime),
  GOTRUE_DB_DRIVER: "postgres",
  GOTRUE_SITE_URL: valueAt(state, "auth", "site_url") || "http://127.0.0.1:3000",
  GOTRUE_JWT_SECRET: secret(state, "secret:auth.settings.jwt_secret"),
  GOTRUE_JWT_EXP: valueAt(state, "auth", "jwt_expiry") || "3600",
  GOTRUE_JWT_AUD: "authenticated",
  GOTRUE_JWT_ADMIN_ROLES: "service_role",
  GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
  GOTRUE_JWT_VALIDMETHODS: "HS256,RS256,ES256",
  GOTRUE_JWT_VALID_METHODS: "HS256,RS256,ES256",
  GOTRUE_API_HOST: "0.0.0.0",
  GOTRUE_API_PORT: String(port),
  API_EXTERNAL_URL: authExternalUrl(state),
  GOTRUE_MAILER_URLPATHS_INVITE: `${authExternalUrl(state)}/verify`,
  GOTRUE_MAILER_URLPATHS_CONFIRMATION: `${authExternalUrl(state)}/verify`,
  GOTRUE_MAILER_URLPATHS_RECOVERY: `${authExternalUrl(state)}/verify`,
  GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: `${authExternalUrl(state)}/verify`,
  GOTRUE_URI_ALLOW_LIST: valueAt(state, "auth", "additional_redirect_urls"),
  GOTRUE_REFRESH_TOKEN_ROTATION_ENABLED: valueAt(state, "auth", "enable_refresh_token_rotation"),
  GOTRUE_REFRESH_TOKEN_REUSE_INTERVAL: valueAt(state, "auth", "refresh_token_reuse_interval"),
  GOTRUE_DISABLE_SIGNUP: valueAt(state, "auth", "enable_signup") === "false" ? "true" : "false",
  GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: valueAt(state, "auth", "enable_anonymous_sign_ins"),
  GOTRUE_PASSWORD_MIN_LENGTH: valueAt(state, "auth", "minimum_password_length"),
  GOTRUE_PASSWORD_REQUIREMENTS: valueAt(state, "auth", "password_requirements"),
  GOTRUE_PASSWORD_REQUIRED_CHARACTERS: passwordRequiredCharacters(state),
  GOTRUE_JWT_ISSUER: valueAt(state, "auth", "jwt_issuer"),
  GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: valueAt(state, "auth", "enable_manual_linking"),
  GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: valueAt(
    state,
    "auth",
    "enable_refresh_token_rotation",
  ),
  GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: valueAt(
    state,
    "auth",
    "refresh_token_reuse_interval",
  ),
  GOTRUE_RATE_LIMIT_EMAIL_SENT: valueAt(state, "auth", "rate_limit.email_sent"),
  GOTRUE_RATE_LIMIT_SMS_SENT: valueAt(state, "auth", "rate_limit.sms_sent"),
  GOTRUE_RATE_LIMIT_ANONYMOUS_USERS: valueAt(state, "auth", "rate_limit.anonymous_users"),
  GOTRUE_RATE_LIMIT_TOKEN_REFRESH: valueAt(state, "auth", "rate_limit.token_refresh"),
  GOTRUE_RATE_LIMIT_VERIFY: valueAt(state, "auth", "rate_limit.token_verifications"),
  GOTRUE_RATE_LIMIT_OTP: valueAt(state, "auth", "rate_limit.sign_in_sign_ups"),
  GOTRUE_RATE_LIMIT_WEB3: valueAt(state, "auth", "rate_limit.web3"),
  GOTRUE_SECURITY_CAPTCHA_ENABLED: valueAt(state, "auth", "captcha.enabled"),
  GOTRUE_SECURITY_CAPTCHA_PROVIDER: valueAt(state, "auth", "captcha.provider"),
  GOTRUE_SECURITY_CAPTCHA_SECRET: valueAt(state, "auth", "captcha.secret"),
  GOTRUE_MFA_TOTP_ENROLL_ENABLED: valueAt(state, "auth", "mfa.totp.enroll_enabled"),
  GOTRUE_MFA_TOTP_VERIFY_ENABLED: valueAt(state, "auth", "mfa.totp.verify_enabled"),
  GOTRUE_MFA_PHONE_ENROLL_ENABLED: valueAt(state, "auth", "mfa.phone.enroll_enabled"),
  GOTRUE_MFA_PHONE_VERIFY_ENABLED: valueAt(state, "auth", "mfa.phone.verify_enabled"),
  GOTRUE_MFA_PHONE_OTP_LENGTH: valueAt(state, "auth", "mfa.phone.otp_length"),
  GOTRUE_MFA_PHONE_TEMPLATE: valueAt(state, "auth", "mfa.phone.template"),
  GOTRUE_MFA_PHONE_MAX_FREQUENCY: valueAt(state, "auth", "mfa.phone.max_frequency"),
  GOTRUE_MFA_WEB_AUTHN_ENROLL_ENABLED: valueAt(state, "auth", "mfa.web_authn.enroll_enabled"),
  GOTRUE_MFA_WEB_AUTHN_VERIFY_ENABLED: valueAt(state, "auth", "mfa.web_authn.verify_enabled"),
  GOTRUE_MFA_MAX_ENROLLED_FACTORS: valueAt(state, "auth", "mfa.max_enrolled_factors"),
  GOTRUE_SESSIONS_TIMEBOX: valueAt(state, "auth", "sessions.timebox"),
  GOTRUE_SESSIONS_INACTIVITY_TIMEOUT: valueAt(state, "auth", "sessions.inactivity_timeout"),
  GOTRUE_MAILER_AUTOCONFIRM:
    valueAt(state, "auth", "email.enable_confirmations") === "false" ? "true" : "false",
  GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED: "true",
  GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: valueAt(state, "auth", "email.secure_password_change"),
  GOTRUE_MAILER_MAX_FREQUENCY: valueAt(state, "auth", "email.max_frequency"),
  GOTRUE_SMTP_MAX_FREQUENCY: valueAt(state, "auth", "email.max_frequency"),
  GOTRUE_MAILER_OTP_LENGTH: valueAt(state, "auth", "email.otp_length"),
  GOTRUE_MAILER_OTP_EXP: valueAt(state, "auth", "email.otp_expiry"),
  GOTRUE_SMTP_HOST: valueAt(state, "auth", "email.smtp.host"),
  GOTRUE_SMTP_PORT: valueAt(state, "auth", "email.smtp.port"),
  GOTRUE_SMTP_USER: valueAt(state, "auth", "email.smtp.user"),
  GOTRUE_SMTP_PASS: valueAt(state, "auth", "email.smtp.pass"),
  GOTRUE_SMTP_ADMIN_EMAIL: valueAt(state, "auth", "email.smtp.admin_email"),
  GOTRUE_SMTP_SENDER_NAME: valueAt(state, "auth", "email.smtp.sender_name"),
  GOTRUE_SMS_AUTOCONFIRM:
    valueAt(state, "auth", "sms.enable_confirmations") === "false" ? "true" : "false",
  GOTRUE_SMS_MAX_FREQUENCY: valueAt(state, "auth", "sms.max_frequency"),
  GOTRUE_SMS_OTP_LENGTH: valueAt(state, "auth", "mfa.phone.otp_length"),
  GOTRUE_SMS_TEMPLATE: valueAt(state, "auth", "sms.template"),
  GOTRUE_SMS_PROVIDER: authSmsProvider(state),
  GOTRUE_SMS_TEST_OTP: authSmsTestOtp(state),
  GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED: valueAt(state, "auth", "web3.solana.enabled"),
  GOTRUE_EXTERNAL_WEB3_ETHEREUM_ENABLED: valueAt(state, "auth", "web3.ethereum.enabled"),
  GOTRUE_EXTERNAL_EMAIL_ENABLED: valueAt(state, "auth", "email.enable_signup"),
  GOTRUE_EXTERNAL_PHONE_ENABLED: valueAt(state, "auth", "sms.enable_signup"),
  GOTRUE_OAUTH_SERVER_ENABLED: valueAt(state, "auth", "oauth_server.enabled"),
  GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH: valueAt(
    state,
    "auth",
    "oauth_server.authorization_url_path",
  ),
  GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION: valueAt(
    state,
    "auth",
    "oauth_server.allow_dynamic_registration",
  ),
});

const withStorageSettings = (
  state: PersistedStackState,
  runtime: WorkloadRuntimeKind,
  port: number,
  workload: PlannedWorkload,
): Record<string, string> => ({
  ...common(workload, port),
  ...capabilityEnv(state, "storage", "STORAGE"),
  PORT: String(port),
  ANON_KEY: secret(state, "secret:auth.settings.anon_key"),
  SERVICE_KEY: secret(state, "secret:auth.settings.service_role_key"),
  AUTH_JWT_SECRET: secret(state, "secret:auth.settings.jwt_secret"),
  DATABASE_URL: dbUrl(state, "supabase_storage_admin", runtime),
  FILE_SIZE_LIMIT: valueAt(state, "storage", "file_size_limit") || "50MiB",
  STORAGE_BACKEND: "file",
  FILE_STORAGE_BACKEND_PATH: "/var/lib/storage",
  STORAGE_FILE_BACKEND_PATH: "/var/lib/storage",
  ENABLE_IMAGE_TRANSFORMATION: valueAt(state, "storage", "image_transformation.enabled") || "false",
  S3_PROTOCOL_ENABLED: valueAt(state, "storage", "s3_protocol.enabled") || "true",
  S3_PROTOCOL_ACCESS_KEY_ID: "local",
  S3_PROTOCOL_ACCESS_KEY_SECRET: "local-secret",
  STORAGE_S3_REGION: "local",
  GLOBAL_S3_BUCKET: "stub",
  TENANT_ID: "stub",
  S3_PROTOCOL_PREFIX: "/storage/v1",
  UPLOAD_FILE_SIZE_LIMIT: "52428800000",
  UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
  SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
  PGRST_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
  TUS_URL_PATH: "/storage/v1/upload/resumable",
  IMGPROXY_URL: runtime === "container" ? "http://supabase-workload:8080" : "http://127.0.0.1:8080",
});

const databaseArgs = (
  state: PersistedStackState,
  port: number,
  runtime: WorkloadRuntimeKind,
): ReadonlyArray<string> => {
  const settings = settingsFor(state, "database");
  const postgresSettings = isRecord(settings) ? settings.settings : undefined;
  const tuning = isRecord(postgresSettings) ? postgresSettings : {};
  const tuned = Object.entries(tuning).flatMap(([key, value]) => {
    const rendered = settingValue(state, value);
    return rendered.length === 0 ? [] : ["-c", `${key}=${rendered}`];
  });
  return [
    "-p",
    String(port),
    "-c",
    runtime === "container" ? "listen_addresses=*" : "listen_addresses=127.0.0.1",
    ...tuned,
  ];
};

const analyticsEnv = (
  state: PersistedStackState,
  runtime: WorkloadRuntimeKind,
  port: number,
  workload: PlannedWorkload,
): Record<string, string> => {
  const backend = valueAt(state, "analytics", "backend") || "postgres";
  return {
    ...common(workload, port),
    ...capabilityEnv(state, "analytics", "ANALYTICS"),
    PORT: String(port),
    PHX_HTTP_PORT: String(port),
    DB_HOSTNAME: dbHost(runtime),
    DB_PORT: String(runtime === "container" ? 5432 : dbPort(state)),
    DB_DATABASE: "_supabase",
    DB_SCHEMA: "_analytics",
    DB_USERNAME: "postgres",
    DB_PASSWORD: secret(state, "secret:database.internal.password"),
    LOGFLARE_SUPABASE_MODE: "true",
    LOGFLARE_SINGLE_TENANT: "true",
    LOGFLARE_PRIVATE_ACCESS_TOKEN: valueAt(state, "analytics", "api_key"),
    LOGFLARE_MIN_CLUSTER_SIZE: "1",
    LOGFLARE_LOG_LEVEL: "warn",
    LOGFLARE_NODE_HOST: runtime === "container" ? "0.0.0.0" : "127.0.0.1",
    RELEASE_COOKIE: "cookie",
    ...(backend === "postgres"
      ? {
          POSTGRES_BACKEND_URL: dbUrl(state, "postgres", runtime),
          POSTGRES_BACKEND_SCHEMA: "_analytics",
        }
      : {
          GOOGLE_DATASET_ID_APPEND: "_prod",
          GOOGLE_PROJECT_ID: valueAt(state, "analytics", "gcp_project_id") || "local",
          GOOGLE_PROJECT_NUMBER: valueAt(state, "analytics", "gcp_project_number") || "0",
        }),
  };
};

const specs: Readonly<Record<string, WorkloadRuntimeSpecDefinition>> = {
  "database:database": {
    containerPort: 5432,
    args: (state, _workload, port) => databaseArgs(state, port, "native"),
    env: (state, workload, port, runtime = "native") => ({
      ...common(workload, port),
      ...capabilityEnv(state, "database", "POSTGRES"),
      PGDATA:
        runtime === "container"
          ? "/var/lib/postgresql/data"
          : `${state.identity.projectRoot}/.supabase/db/data`,
      POSTGRES_PASSWORD: secret(state, "secret:database.internal.password"),
      TZDIR: "/var/db/timezone/zoneinfo",
    }),
    containerArgs: (state, _workload, port) => databaseArgs(state, port, "container"),
    readiness: { protocol: "tcp" },
    networkAliases: [DATABASE_NETWORK_ALIAS],
  },
  "rest:rest": {
    containerPort: 3000,
    args: () => [],
    env: (state, workload, port, runtime = "native") =>
      withRestSettings(state, runtime, port, workload),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/" },
  },
  "auth:auth": {
    containerPort: 9999,
    args: () => [],
    env: (state, workload, port, runtime = "native") =>
      withAuthSettings(state, runtime, port, workload),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/health" },
  },
  "realtime:realtime": {
    containerPort: 4000,
    args: () => [],
    env: (state, workload, port, runtime = "native") => ({
      ...common(workload, port),
      ...capabilityEnv(state, "realtime", "REALTIME"),
      PORT: String(port),
      DB_HOST: dbHost(runtime),
      DB_PORT: String(runtime === "container" ? 5432 : dbPort(state)),
      DB_USER: "postgres",
      DB_PASSWORD: secret(state, "secret:database.internal.password"),
      DB_NAME: "postgres",
      DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
      API_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      API_JWT_JWKS: "",
      METRICS_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      APP_NAME: "realtime",
      SEED_SELF_HOST: "true",
      MAX_HEADER_LENGTH: valueAt(state, "realtime", "max_header_length") || "4096",
      RUN_JANITOR: "true",
    }),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/api/ping" },
  },
  "storage:storage": {
    containerPort: 5000,
    args: () => [],
    env: (state, workload, port, runtime = "native") =>
      withStorageSettings(state, runtime, port, workload),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/status" },
  },
  "storage:imgproxy": {
    containerPort: 8080,
    args: () => [],
    env: (state, workload, port, runtime = "native") => ({
      ...common(workload, port),
      IMGPROXY_BIND: `${runtime === "container" ? "0.0.0.0" : "127.0.0.1"}:${port}`,
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
    }),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/health" },
  },
  "functions:edge-runtime": {
    containerPort: 9000,
    cwd: functionsRoot,
    args: (state, _workload, port) => [
      "start",
      `--main-service=${functionsRoot(state)}`,
      `--port=${port}`,
      `--policy=${valueAt(state, "functions", "edge_runtime.policy") || "per_worker"}`,
    ],
    env: (state, workload, port) => ({
      ...common(workload, port),
      ...capabilityEnv(state, "functions", "FUNCTIONS"),
      EDGE_RUNTIME_PORT: String(port),
      FUNCTIONS_ROOT: functionsRoot(state),
      FUNCTIONS_CONTAINER_ROOT,
      EDGE_RUNTIME_POLICY: valueAt(state, "functions", "edge_runtime.policy") || "per_worker",
      EDGE_RUNTIME_DENO_VERSION: valueAt(state, "functions", "edge_runtime.deno_version") || "2",
      INSPECTOR_MODE: valueAt(state, "functions", "inspector.mode"),
      INSPECTOR_MAIN: valueAt(state, "functions", "inspector.main"),
    }),
    containerArgs: (state, _workload, port) => [
      "start",
      `--main-service=${FUNCTIONS_CONTAINER_ROOT}`,
      `--port=${port}`,
      `--policy=${valueAt(state, "functions", "edge_runtime.policy") || "per_worker"}`,
    ],
    containerMounts: (state) => [
      { source: functionsRoot(state), target: FUNCTIONS_CONTAINER_ROOT, readOnly: true },
    ],
    readiness: { protocol: "http", path: "/_internal/health" },
  },
  "studio:studio": {
    containerPort: 3000,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      ...capabilityEnv(state, "studio", "STUDIO"),
      PORT: String(port),
      HOSTNAME: "0.0.0.0",
      SUPABASE_URL: valueAt(state, "studio", "api_url") || "http://127.0.0.1",
      SUPABASE_PUBLIC_URL: valueAt(state, "studio", "api_url") || "http://127.0.0.1",
      CURRENT_CLI_VERSION: "local",
      POSTGRES_PASSWORD: secret(state, "secret:database.internal.password"),
      POSTGRES_USER_READ_WRITE: "postgres",
      PGRST_DB_SCHEMAS: "public,graphql_public",
      PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
      PGRST_DB_MAX_ROWS: "1000",
    }),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/api/platform/profile" },
  },
  "studio:pgmeta": {
    containerPort: 8080,
    args: () => [],
    env: (state, workload, port, runtime = "native") => ({
      ...common(workload, port),
      ...capabilityEnv(state, "studio", "PG_META"),
      PG_META_PORT: String(port),
      PG_META_DB_HOST: dbHost(runtime),
      PG_META_DB_PORT: String(runtime === "container" ? 5432 : dbPort(state)),
      PG_META_DB_NAME: "postgres",
      PG_META_DB_USER: "postgres",
      PG_META_DB_PASSWORD: secret(state, "secret:database.internal.password"),
    }),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/health" },
  },
  "mail:mail": {
    containerPort: 8025,
    args: (_state, _workload, port) => ["--ui", `127.0.0.1:${port}`],
    env: (state, workload, port, runtime = "native") => ({
      ...common(workload, port),
      ...capabilityEnv(state, "mail", "MAIL"),
      MP_UI_BIND_ADDR: `${runtime === "container" ? "0.0.0.0" : "127.0.0.1"}:${port}`,
      MP_SMTP_BIND_ADDR: `${runtime === "container" ? "0.0.0.0" : "127.0.0.1"}:1025`,
      MP_POP3_BIND_ADDR: `${runtime === "container" ? "0.0.0.0" : "127.0.0.1"}:1110`,
      MP_SMTP_DISABLE_RDNS: "true",
    }),
    containerArgs: (_state, _workload, port) => ["--ui", `0.0.0.0:${port}`],
    readiness: { protocol: "http", path: "/readyz" },
  },
  "analytics:analytics": {
    containerPort: 4000,
    args: () => [],
    env: (state, workload, port, runtime = "native") =>
      analyticsEnv(state, runtime, port, workload),
    containerArgs: () => [],
    readiness: { protocol: "http", path: "/health" },
  },
  "analytics:vector": {
    containerPort: 9001,
    args: (_state, _workload, _port) => [
      "--config",
      "/etc/vector/vector.yaml",
      "--watch-config",
      "false",
    ],
    env: (state, workload, port) => ({
      ...common(workload, port),
      ...capabilityEnv(state, "analytics", "VECTOR"),
      VECTOR_API_PORT: String(port),
    }),
    containerArgs: (_state, _workload, _port) => [
      "--config",
      "/etc/vector/vector.yaml",
      "--watch-config",
      "false",
    ],
    readiness: { protocol: "http", path: "/health" },
  },
  "pooler:pooler": {
    containerPort: 6543,
    args: () => ["start"],
    env: (state, workload, port, runtime = "native") => ({
      ...common(workload, port),
      ...capabilityEnv(state, "pooler", "POOLER"),
      PORT: String(port),
      PROXY_PORT_TRANSACTION: String(port),
      DATABASE_URL: `ecto://postgres:${secret(state, "secret:database.internal.password")}@${dbHost(runtime)}:${runtime === "container" ? 5432 : dbPort(state)}/_supabase`,
      API_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      REGION: "local",
      CLUSTER_POSTGRES: "true",
      SECRET_KEY_BASE: valueAt(state, "pooler", "secret_key_base"),
      VAULT_ENC_KEY: valueAt(state, "pooler", "encryption_key"),
      METRICS_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      DEFAULT_POOL_SIZE: valueAt(state, "pooler", "default_pool_size") || "20",
      MAX_CLIENT_CONN: valueAt(state, "pooler", "max_client_conn") || "100",
      POOL_MODE: valueAt(state, "pooler", "pool_mode") || "transaction",
    }),
    containerArgs: () => ["/bin/sh", "-c", "/app/bin/migrate && /app/bin/server"],
    readiness: { protocol: "tcp" },
  },
};

export const runtimeSpecFor = (workload: PlannedWorkload): WorkloadRuntimeSpec | undefined => {
  const spec = specs[workload.id];
  if (spec === undefined) return undefined;
  return {
    ...spec,
    cwd: spec.cwd ?? ((state) => state.identity.projectRoot),
    privateEndpoint:
      spec.privateEndpoint ?? ((port, runtime = "native") => privateEndpointFor(port, runtime)),
  };
};

/** Adapter consumed by ContainerRuntime; env is written to an env-file by its owner. */
export const containerResolutionFor = (
  state: PersistedStackState,
  workload: PlannedWorkload,
  port: number,
): ContainerWorkloadResolution | undefined => {
  const spec = runtimeSpecFor(workload);
  if (spec === undefined) return undefined;
  return {
    command: spec.containerArgs(state, workload, spec.containerPort),
    env: spec.env(state, workload, port, "container"),
    mounts: spec.containerMounts?.(state, workload) ?? [],
    networkAliases: spec.networkAliases ?? [],
  };
};

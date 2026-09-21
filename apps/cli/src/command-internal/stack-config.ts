import { getDefaultCliConfig, type CliConfig } from "@supabase/config";
import { validateCliConfig } from "@supabase/config/effect";
import { Crypto, Effect, Data, FileSystem, Path, Redacted, SchemaIssue } from "effect";
import type { ServiceCreation as ServiceCreationType } from "@supabase/stack/effect";

import { loadLocalProjectContext, type LocalProjectContext } from "./local-project-context.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { parseFileSizeLimit } from "./storage-bucket-config.ts";

declare const SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE: string | undefined;
import {
  envOverride,
  envOverrideApiMaxRows,
  envOverrideAuthPasswordRequirements,
  envOverrideAnalyticsBackend,
  envOverrideBool,
  envOverrideDefaultPoolSize,
  envOverrideDenoVersion,
  envOverrideEdgeRuntimePolicy,
  envOverrideMaxClientConn,
  envOverrideMajorVersion,
  envOverridePort,
  envOverridePoolMode,
  envOverrideRealtimeIpVersion,
  envOverrideRealtimeMaxHeaderLength,
  envOverrideUint,
  resolveAuthCaptcha,
  resolveAuthEmail,
  resolveAuthEmailSmtp,
  resolveAuthExternalProviders,
  resolveAuthHooks,
  resolveAuthMfa,
  resolveAuthSms,
  resolveDbSettingsEnvOverrides,
  resolveGotrueOAuthServer,
  resolveGotrueRateLimit,
  resolveGotrueSessions,
  resolveGotrueWeb3,
  strToArr,
} from "./local-config-values.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/** A config error suitable for a stack command's user-facing boundary. */
export class StackConfigError extends Data.TaggedError("StackConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

interface StackStartConfig {
  readonly jwtSecret: Redacted.Redacted<string>;
  readonly creations: (
    stackId: string,
    options?: { readonly jwtSecret?: Redacted.Redacted<string> },
  ) => Effect.Effect<ReadonlyArray<ServiceCreationType>, StackConfigError>;
  readonly source: CliConfig;
  readonly projectEnvValues: Readonly<Record<string, string>>;
  readonly document?: Record<string, unknown>;
}

type StackConfigEffect = Effect.Effect<
  StackStartConfig,
  StackConfigError,
  FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto
>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutUndefined = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return value;
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]),
  );
};

const section = (document: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = document?.[name];
  return isRecord(value) ? value : undefined;
};

const explicitPort = (
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  key: string,
): number | undefined => {
  const value = section(document, sectionName)?.[key];
  return typeof value === "number" ? value : undefined;
};

const envPortOrConfigured = (
  name: string,
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  key: string,
  configured: number,
  env: Readonly<Record<string, string>>,
): number | undefined => {
  if (envOverride(name, undefined, env) !== undefined) return configured;
  return explicitPort(document, sectionName, key) === undefined ? undefined : configured;
};

const envNestedPortOrConfigured = (
  name: string,
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  nestedSection: string,
  key: string,
  configured: number,
  env: Readonly<Record<string, string>>,
): number | undefined => {
  if (envOverride(name, undefined, env) !== undefined) return configured;
  const nested = section(section(document, sectionName), nestedSection);
  return typeof nested?.[key] === "number" ? configured : undefined;
};

const authProviderNames = [
  "apple",
  "azure",
  "bitbucket",
  "discord",
  "facebook",
  "github",
  "gitlab",
  "google",
  "kakao",
  "keycloak",
  "linkedin_oidc",
  "notion",
  "twitch",
  "twitter",
  "x",
  "slack_oidc",
  "spotify",
  "workos",
  "zoom",
] as const;

const resolvedPort = (
  name: string,
  configured: number,
  field: string,
  env: Readonly<Record<string, string>>,
) =>
  envOverride(name, undefined, env) === undefined
    ? configured
    : envOverridePort(name, configured, field, env);

const resolveAuthOverrides = (
  auth: CliConfig["auth"],
  document: Readonly<Record<string, unknown>> | undefined,
  env: Readonly<Record<string, string>>,
) => {
  const authDocument = section(document, "auth");
  const email = resolveAuthEmail(auth.email, authDocument, env);
  const smtp = resolveAuthEmailSmtp(authDocument, env);
  const hooks = resolveAuthHooks(authDocument, auth.hook, env);
  const external = resolveAuthExternalProviders(authDocument, auth.external, env);
  const externalResolved = { ...auth.external };
  for (const name of authProviderNames) {
    const value = external[name];
    if (value === undefined) continue;
    externalResolved[name] = {
      ...externalResolved[name],
      enabled: value.enabled,
      client_id: value.clientId ?? externalResolved[name].client_id,
      secret: value.secret,
      url: value.url,
      redirect_uri: value.redirectUri ?? externalResolved[name].redirect_uri,
      skip_nonce_check: value.skipNonceCheck,
      email_optional: value.emailOptional,
    };
  }
  const figma = external.figma;
  if (figma !== undefined) {
    externalResolved.figma = {
      ...externalResolved.figma,
      enabled: figma.enabled,
      client_id: figma.clientId ?? externalResolved.figma?.client_id,
      secret: figma.secret,
      url: figma.url,
      redirect_uri: figma.redirectUri ?? externalResolved.figma?.redirect_uri,
      skip_nonce_check: figma.skipNonceCheck,
      email_optional: figma.emailOptional,
    };
  }
  const hookValue = (
    value: (typeof hooks)[keyof typeof hooks],
    fallback: (typeof auth.hook)[keyof typeof auth.hook],
  ) => value ?? fallback;
  const hookResolved = {
    mfa_verification_attempt: hookValue(
      hooks.mfaVerificationAttempt,
      auth.hook.mfa_verification_attempt,
    ),
    password_verification_attempt: hookValue(
      hooks.passwordVerificationAttempt,
      auth.hook.password_verification_attempt,
    ),
    custom_access_token: hookValue(hooks.customAccessToken, auth.hook.custom_access_token),
    send_sms: hookValue(hooks.sendSms, auth.hook.send_sms),
    send_email: hookValue(hooks.sendEmail, auth.hook.send_email),
    before_user_created: hookValue(hooks.beforeUserCreated, auth.hook.before_user_created),
  };
  const resolvedEmailTemplate: CliConfig["auth"]["email"]["template"] = Object.fromEntries(
    Object.entries(email.template).map(([name, value]) => [
      name,
      { subject: value.subject ?? "", content_path: value.content_path },
    ]),
  );
  const resolvedEmailNotification: CliConfig["auth"]["email"]["notification"] = Object.fromEntries(
    Object.entries(email.notification).map(([name, value]) => [
      name,
      {
        enabled: value.enabled,
        subject: value.subject ?? "",
        content_path: value.content_path,
      },
    ]),
  );
  const resolvedEmail = {
    ...email,
    template: resolvedEmailTemplate,
    notification: resolvedEmailNotification,
  };
  const additionalRedirectUrls = envOverride(
    "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
    undefined,
    env,
  );
  const resolvedSmtp =
    smtp === undefined
      ? undefined
      : {
          enabled: smtp.enabled,
          host: smtp.host,
          ...(smtp.port === 0 ? {} : { port: smtp.port }),
          user: smtp.user,
          pass: smtp.pass,
          admin_email: smtp.adminEmail,
          sender_name: smtp.senderName,
        };
  const thirdParty = {
    firebase: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
        auth.third_party.firebase.enabled,
        "auth.third_party.firebase.enabled",
        env,
      ),
      project_id: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID",
        auth.third_party.firebase.project_id,
        env,
      ),
    },
    auth0: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_ENABLED",
        auth.third_party.auth0.enabled,
        "auth.third_party.auth0.enabled",
        env,
      ),
      tenant: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT",
        auth.third_party.auth0.tenant,
        env,
      ),
      tenant_region: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT_REGION",
        auth.third_party.auth0.tenant_region,
        env,
      ),
    },
    aws_cognito: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_ENABLED",
        auth.third_party.aws_cognito.enabled,
        "auth.third_party.aws_cognito.enabled",
        env,
      ),
      user_pool_id: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
        auth.third_party.aws_cognito.user_pool_id,
        env,
      ),
      user_pool_region: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_REGION",
        auth.third_party.aws_cognito.user_pool_region,
        env,
      ),
    },
    clerk: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
        auth.third_party.clerk.enabled,
        "auth.third_party.clerk.enabled",
        env,
      ),
      domain: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
        auth.third_party.clerk.domain,
        env,
      ),
    },
    workos: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
        auth.third_party.workos.enabled,
        "auth.third_party.workos.enabled",
        env,
      ),
      issuer_url: envOverride(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
        auth.third_party.workos.issuer_url,
        env,
      ),
    },
  };
  return {
    ...auth,
    enabled: envOverrideBool("SUPABASE_AUTH_ENABLED", auth.enabled, "auth.enabled", env),
    site_url: envOverride("SUPABASE_AUTH_SITE_URL", auth.site_url, env),
    additional_redirect_urls:
      additionalRedirectUrls === undefined
        ? auth.additional_redirect_urls
        : strToArr(additionalRedirectUrls),
    jwt_expiry: envOverrideUint(
      "SUPABASE_AUTH_JWT_EXPIRY",
      "auth.jwt_expiry",
      auth.jwt_expiry,
      env,
    ),
    enable_refresh_token_rotation: envOverrideBool(
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      auth.enable_refresh_token_rotation,
      "auth.enable_refresh_token_rotation",
      env,
    ),
    refresh_token_reuse_interval: envOverrideUint(
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      "auth.refresh_token_reuse_interval",
      auth.refresh_token_reuse_interval,
      env,
    ),
    enable_manual_linking: envOverrideBool(
      "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
      auth.enable_manual_linking,
      "auth.enable_manual_linking",
      env,
    ),
    enable_signup: envOverrideBool(
      "SUPABASE_AUTH_ENABLE_SIGNUP",
      auth.enable_signup,
      "auth.enable_signup",
      env,
    ),
    enable_anonymous_sign_ins: envOverrideBool(
      "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
      auth.enable_anonymous_sign_ins,
      "auth.enable_anonymous_sign_ins",
      env,
    ),
    minimum_password_length: envOverrideUint(
      "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
      "auth.minimum_password_length",
      auth.minimum_password_length,
      env,
    ),
    password_requirements: envOverrideAuthPasswordRequirements(auth.password_requirements, env),
    publishable_key: envOverride("SUPABASE_AUTH_PUBLISHABLE_KEY", auth.publishable_key, env),
    secret_key: envOverride("SUPABASE_AUTH_SECRET_KEY", auth.secret_key, env),
    anon_key: envOverride("SUPABASE_AUTH_ANON_KEY", auth.anon_key, env),
    service_role_key: envOverride("SUPABASE_AUTH_SERVICE_ROLE_KEY", auth.service_role_key, env),
    rate_limit: resolveGotrueRateLimit(auth.rate_limit, env),
    captcha: resolveAuthCaptcha(authDocument, auth.captcha, env),
    hook: hookResolved,
    mfa: resolveAuthMfa(auth.mfa, env),
    sessions: resolveGotrueSessions(auth.sessions, env),
    email: { ...resolvedEmail, smtp: resolvedSmtp },
    sms: resolveAuthSms(authDocument, auth.sms, env),
    external: externalResolved,
    web3: resolveGotrueWeb3(auth.web3, env),
    oauth_server: resolveGotrueOAuthServer(auth.oauth_server, env),
    third_party: thirdParty,
  };
};

const resolveEffectiveCliConfig = (
  config: CliConfig,
  document: Readonly<Record<string, unknown>> | undefined,
  env: Readonly<Record<string, string>>,
): CliConfig => {
  const api = config.api;
  const db = config.db;
  const storage = config.storage;
  const realtime = config.realtime;
  const analytics = config.analytics;
  const studio = config.studio;
  const mail = config.local_smtp;
  const pooler = db.pooler;
  const edge = config.edge_runtime;
  const experimental = {
    ...config.experimental,
    orioledb_version: envOverride(
      "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
      config.experimental.orioledb_version,
      env,
    ),
  };
  const apiSchemasOverride = envOverride("SUPABASE_API_SCHEMAS", undefined, env);
  const apiExtraSearchPathOverride = envOverride("SUPABASE_API_EXTRA_SEARCH_PATH", undefined, env);
  const imageDocument = section(section(document, "storage"), "image_transformation");
  const imageEnabledOverride = envOverride(
    "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
    undefined,
    env,
  );
  const imageEnabledExplicit =
    imageDocument?.enabled !== undefined || imageEnabledOverride !== undefined;
  const resolvedApi = {
    ...api,
    enabled: envOverrideBool("SUPABASE_API_ENABLED", api.enabled, "api.enabled", env),
    port: resolvedPort("SUPABASE_API_PORT", api.port, "api.port", env),
    schemas: apiSchemasOverride === undefined ? api.schemas : strToArr(apiSchemasOverride),
    extra_search_path:
      apiExtraSearchPathOverride === undefined
        ? api.extra_search_path
        : strToArr(apiExtraSearchPathOverride),
    max_rows: envOverrideApiMaxRows(api.max_rows, env),
    tls: {
      ...api.tls,
      enabled: envOverrideBool("SUPABASE_API_TLS_ENABLED", api.tls.enabled, "api.tls.enabled", env),
      cert_path: envOverride("SUPABASE_API_TLS_CERT_PATH", api.tls.cert_path, env),
      key_path: envOverride("SUPABASE_API_TLS_KEY_PATH", api.tls.key_path, env),
    },
    external_url: envOverride("SUPABASE_API_EXTERNAL_URL", api.external_url, env),
    auto_expose_new_tables:
      api.auto_expose_new_tables !== undefined ||
      envOverride("SUPABASE_API_AUTO_EXPOSE_NEW_TABLES", undefined, env) !== undefined
        ? envOverrideBool(
            "SUPABASE_API_AUTO_EXPOSE_NEW_TABLES",
            api.auto_expose_new_tables ?? false,
            "api.auto_expose_new_tables",
            env,
          )
        : undefined,
  };
  const resolvedStorage = {
    ...storage,
    enabled: envOverrideBool("SUPABASE_STORAGE_ENABLED", storage.enabled, "storage.enabled", env),
    file_size_limit: envOverride(
      "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
      String(storage.file_size_limit),
      env,
    ),
    image_transformation: imageEnabledExplicit
      ? {
          ...storage.image_transformation,
          enabled: envOverrideBool(
            "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
            storage.image_transformation?.enabled ?? false,
            "storage.image_transformation.enabled",
            env,
          ),
        }
      : undefined,
    s3_protocol: {
      ...storage.s3_protocol,
      enabled: envOverrideBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        env,
      ),
    },
    analytics: {
      ...storage.analytics,
      enabled: envOverrideBool(
        "SUPABASE_STORAGE_ANALYTICS_ENABLED",
        storage.analytics.enabled,
        "storage.analytics.enabled",
        env,
      ),
      max_namespaces: envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
        "storage.analytics.max_namespaces",
        storage.analytics.max_namespaces,
        env,
      ),
      max_tables: envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
        "storage.analytics.max_tables",
        storage.analytics.max_tables,
        env,
      ),
      max_catalogs: envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
        "storage.analytics.max_catalogs",
        storage.analytics.max_catalogs,
        env,
      ),
    },
    vector: {
      ...storage.vector,
      enabled: envOverrideBool(
        "SUPABASE_STORAGE_VECTOR_ENABLED",
        storage.vector.enabled,
        "storage.vector.enabled",
        env,
      ),
      max_buckets: envOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
        "storage.vector.max_buckets",
        storage.vector.max_buckets,
        env,
      ),
      max_indexes: envOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
        "storage.vector.max_indexes",
        storage.vector.max_indexes,
        env,
      ),
    },
  };
  const resolvedEdge = {
    ...edge,
    enabled: envOverrideBool(
      "SUPABASE_EDGE_RUNTIME_ENABLED",
      edge.enabled,
      "edge_runtime.enabled",
      env,
    ),
    policy: envOverrideEdgeRuntimePolicy(edge.policy, env),
    deno_version: envOverrideDenoVersion(edge.deno_version, env),
    inspector_port: resolvedPort(
      "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
      edge.inspector_port,
      "edge_runtime.inspector_port",
      env,
    ),
  };
  const resolvedAnalytics = {
    ...analytics,
    enabled: envOverrideBool(
      "SUPABASE_ANALYTICS_ENABLED",
      analytics.enabled,
      "analytics.enabled",
      env,
    ),
    port: resolvedPort("SUPABASE_ANALYTICS_PORT", analytics.port, "analytics.port", env),
    backend: envOverrideAnalyticsBackend(analytics.backend, env),
    gcp_project_id: envOverride("SUPABASE_ANALYTICS_GCP_PROJECT_ID", analytics.gcp_project_id, env),
    gcp_project_number: envOverride(
      "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
      analytics.gcp_project_number,
      env,
    ),
    gcp_jwt_path: envOverride("SUPABASE_ANALYTICS_GCP_JWT_PATH", analytics.gcp_jwt_path, env),
  };
  const resolvedPooler = {
    ...pooler,
    enabled: envOverrideBool(
      "SUPABASE_DB_POOLER_ENABLED",
      pooler.enabled,
      "db.pooler.enabled",
      env,
    ),
    port: resolvedPort("SUPABASE_DB_POOLER_PORT", pooler.port, "db.pooler.port", env),
    pool_mode: envOverridePoolMode(pooler.pool_mode, env),
    default_pool_size: envOverrideDefaultPoolSize(pooler.default_pool_size, env),
    max_client_conn: envOverrideMaxClientConn(pooler.max_client_conn, env),
  };
  const authEnabled = envOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    env,
  );
  // JWT security settings apply to non-Auth workloads too, so resolve them
  // regardless of whether the Auth capability is enabled.
  const authResolved = {
    ...(authEnabled ? resolveAuthOverrides(config.auth, document, env) : config.auth),
    enabled: authEnabled,
    jwt_issuer: envOverride("SUPABASE_AUTH_JWT_ISSUER", config.auth.jwt_issuer, env),
    signing_keys_path: envOverride(
      "SUPABASE_AUTH_SIGNING_KEYS_PATH",
      config.auth.signing_keys_path,
      env,
    ),
    jwt_secret: envOverride("SUPABASE_AUTH_JWT_SECRET", config.auth.jwt_secret, env),
  };
  return {
    ...config,
    api: resolvedApi,
    auth: authResolved,
    db: {
      ...db,
      port: resolvedPort("SUPABASE_DB_PORT", db.port, "db.port", env),
      major_version: envOverrideMajorVersion(db.major_version, env),
      health_timeout: envOverride("SUPABASE_DB_HEALTH_TIMEOUT", db.health_timeout, env),
      settings: resolveDbSettingsEnvOverrides(db.settings, env),
      pooler: resolvedPooler,
    },
    edge_runtime: resolvedEdge,
    experimental,
    realtime: {
      ...realtime,
      enabled: envOverrideBool(
        "SUPABASE_REALTIME_ENABLED",
        realtime.enabled,
        "realtime.enabled",
        env,
      ),
      ip_version: envOverrideRealtimeIpVersion(realtime.ip_version, env),
      max_header_length: envOverrideRealtimeMaxHeaderLength(realtime.max_header_length, env),
    },
    storage: resolvedStorage,
    analytics: resolvedAnalytics,
    studio: {
      ...studio,
      enabled: envOverrideBool("SUPABASE_STUDIO_ENABLED", studio.enabled, "studio.enabled", env),
      port: resolvedPort("SUPABASE_STUDIO_PORT", studio.port, "studio.port", env),
      api_url: envOverride("SUPABASE_STUDIO_API_URL", studio.api_url, env),
      openai_api_key: envOverride("SUPABASE_STUDIO_OPENAI_API_KEY", studio.openai_api_key, env),
    },
    local_smtp: {
      ...mail,
      enabled: envOverrideBool(
        "SUPABASE_LOCAL_SMTP_ENABLED",
        mail.enabled,
        "local_smtp.enabled",
        env,
      ),
      port: resolvedPort("SUPABASE_LOCAL_SMTP_PORT", mail.port, "local_smtp.port", env),
      smtp_port: resolvedPort(
        "SUPABASE_LOCAL_SMTP_SMTP_PORT",
        mail.smtp_port ?? 0,
        "local_smtp.smtp_port",
        env,
      ),
      pop3_port: resolvedPort(
        "SUPABASE_LOCAL_SMTP_POP3_PORT",
        mail.pop3_port ?? 0,
        "local_smtp.pop3_port",
        env,
      ),
      admin_email: envOverride("SUPABASE_LOCAL_SMTP_ADMIN_EMAIL", mail.admin_email, env),
      sender_name: envOverride("SUPABASE_LOCAL_SMTP_SENDER_NAME", mail.sender_name, env),
    },
  };
};

const unsupportedConfigPaths = [
  "auth.additional_redirect_urls",
  "auth.enable_refresh_token_rotation",
  "auth.refresh_token_reuse_interval",
  "auth.enable_manual_linking",
  "auth.enable_anonymous_sign_ins",
  "auth.minimum_password_length",
  "auth.password_requirements",
  "auth.rate_limit",
  "auth.captcha",
  "auth.hook",
  "auth.mfa",
  "auth.sessions",
  "auth.email",
  "auth.sms",
  "auth.external",
  "auth.web3",
  "auth.oauth_server",
  "auth.third_party",
  "auth.jwt_issuer",
  "auth.publishable_key",
  "auth.secret_key",
  "auth.anon_key",
  "auth.service_role_key",
  "api.extra_search_path",
  "api.tls",
  "analytics.vector_port",
  "analytics.gcp_project_id",
  "analytics.gcp_project_number",
  "analytics.gcp_jwt_path",
  "db.pooler.default_pool_size",
  "db.pooler.max_client_conn",
  "edge_runtime.secrets",
  "edge_runtime.deno_version",
  "edge_runtime.inspector_port",
  "realtime.ip_version",
  "realtime.max_header_length",
  "storage.analytics",
  "storage.s3_protocol",
  "studio.api_url",
  "studio.openai_api_key",
  "local_smtp.admin_email",
  "local_smtp.sender_name",
  "experimental.orioledb_version",
  "experimental.s3_host",
  "experimental.s3_region",
  "experimental.s3_access_key",
  "experimental.s3_secret_key",
] as const;

const pathValue = (value: unknown, path: string): unknown => {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
};

const valuesEqual = (left: unknown, right: unknown): boolean => {
  if ((left === undefined && right === "") || (left === "" && right === undefined)) return true;
  if (Redacted.isRedacted(left) || Redacted.isRedacted(right)) {
    return (
      Redacted.isRedacted(left) &&
      Redacted.isRedacted(right) &&
      Redacted.value(left) === Redacted.value(right)
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => valuesEqual(left[key], right[key]));
  }
  return Object.is(left, right);
};

const firstDifference = (left: unknown, right: unknown, path: string): string | undefined => {
  if (valuesEqual(left, right)) return undefined;
  if (isRecord(left) && isRecord(right)) {
    if (left.enabled === false && right.enabled === false) return undefined;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  return path;
};

const configValidationError = (
  config: CliConfig,
  effectiveEdgeEnabled: boolean,
): string | undefined => {
  const defaults = getDefaultCliConfig();
  const figma = config.auth.external.figma;
  if (config.auth.enabled && figma?.enabled === true)
    return "auth.external.figma is enabled but unsupported by the experimental stack";
  if (config.auth.signing_keys_path !== undefined)
    return "auth.signing_keys_path is unsupported by the experimental stack";
  for (const path of unsupportedConfigPaths) {
    if (path.startsWith("auth.") && !config.auth.enabled) continue;
    const value = pathValue(config, path);
    const baseline = pathValue(defaults, path);
    const difference = firstDifference(value, baseline, path);
    if (difference !== undefined) return `${difference} is unsupported by the experimental stack`;
  }
  if (config.analytics.enabled && config.analytics.backend !== "postgres")
    return "analytics.backend must be postgres for the experimental stack";
  if (
    config.storage.vector.max_buckets !== defaults.storage.vector.max_buckets ||
    config.storage.vector.max_indexes !== defaults.storage.vector.max_indexes ||
    Object.keys(config.storage.vector.buckets).length > 0
  )
    return "storage.vector settings are unsupported by the experimental stack";
  if (config.db.major_version !== 15 && config.db.major_version !== 17)
    return "db.major_version must be 15 or 17 for the experimental stack";
  if (!effectiveEdgeEnabled) return undefined;
  for (const [name, functionConfig] of Object.entries(config.functions)) {
    const functionDefaults = {
      enabled: true,
      verify_jwt: true,
      import_map: "",
      entrypoint: "",
      static_files: [],
      env: {},
    };
    for (const field of [
      "enabled",
      "verify_jwt",
      "import_map",
      "entrypoint",
      "static_files",
      "env",
    ] as const) {
      if (!valuesEqual(functionConfig[field], functionDefaults[field]))
        return `functions.${name}.${field} is unsupported by the experimental stack`;
    }
  }
  return undefined;
};

const endpoint = (port: number | undefined): { readonly port: number | "auto" } => ({
  port: port === undefined ? "auto" : port,
});

/** Loads and translates the effective project config for all stack commands.
 * Pass `opts.context` to reuse an already-loaded project context. */
export const loadStackConfig = Effect.fn("StackConfig.load")(
  (projectRoot: string, opts?: { readonly context?: LocalProjectContext }): StackConfigEffect =>
    Effect.gen(function* () {
      const context =
        opts?.context ??
        (yield* loadLocalProjectContext(
          projectRoot,
          (message) => new StackConfigError({ message }),
        ));
      const effectiveInput = yield* Effect.try({
        try: () =>
          resolveEffectiveCliConfig(
            context.config,
            context.loaded?.document,
            context.projectEnvValues,
          ),
        catch: (cause) =>
          new StackConfigError({
            message: cause instanceof Error ? cause.message : "invalid config overrides",
          }),
      });
      const validatedConfig = yield* validateCliConfig(withoutUndefined(effectiveInput)).pipe(
        Effect.mapError((cause) => {
          const issues = SchemaIssue.makeFormatterStandardSchemaV1({
            leafHook: () => "Invalid value",
            checkHook: () => undefined,
          })(cause.issue).issues;
          const path = issues[0]?.path
            ?.map((segment) => String(typeof segment === "object" ? segment.key : segment))
            .join(".");
          return new StackConfigError({
            message: path === undefined ? "invalid config" : `invalid config at ${path}`,
          });
        }),
      );
      const validationError = configValidationError(
        validatedConfig,
        validatedConfig.edge_runtime.enabled,
      );
      if (validationError !== undefined)
        return yield* new StackConfigError({ message: validationError });

      const crypto = yield* Crypto.Crypto;
      const storageFileSizeLimit = yield* Effect.try({
        try: () => String(parseFileSizeLimit(validatedConfig.storage.file_size_limit)),
        catch: (cause) =>
          new StackConfigError({ message: `Invalid storage.file_size_limit: ${String(cause)}` }),
      });
      const jwtSecret =
        validatedConfig.auth.jwt_secret === undefined
          ? Redacted.make(
              yield* crypto.randomUUIDv4.pipe(
                Effect.mapError(
                  (cause) =>
                    new StackConfigError({ message: `Unable to generate JWT secret: ${cause}` }),
                ),
              ),
            )
          : Redacted.make(validatedConfig.auth.jwt_secret);
      const document = context.loaded?.document;
      const dbPort = envPortOrConfigured(
        "SUPABASE_DB_PORT",
        document,
        "db",
        "port",
        validatedConfig.db.port,
        context.projectEnvValues,
      );
      const apiPort = envPortOrConfigured(
        "SUPABASE_API_PORT",
        document,
        "api",
        "port",
        validatedConfig.api.port,
        context.projectEnvValues,
      );
      const studioPort = envPortOrConfigured(
        "SUPABASE_STUDIO_PORT",
        document,
        "studio",
        "port",
        validatedConfig.studio.port,
        context.projectEnvValues,
      );
      const poolerPort = envNestedPortOrConfigured(
        "SUPABASE_DB_POOLER_PORT",
        document,
        "db",
        "pooler",
        "port",
        validatedConfig.db.pooler.port,
        context.projectEnvValues,
      );
      const mailPort = envPortOrConfigured(
        "SUPABASE_LOCAL_SMTP_PORT",
        document,
        "local_smtp",
        "port",
        validatedConfig.local_smtp.port,
        context.projectEnvValues,
      );
      const mailSmtpPort = envPortOrConfigured(
        "SUPABASE_LOCAL_SMTP_SMTP_PORT",
        document,
        "local_smtp",
        "smtp_port",
        validatedConfig.local_smtp.smtp_port ?? 0,
        context.projectEnvValues,
      );
      const mailPop3Port = envPortOrConfigured(
        "SUPABASE_LOCAL_SMTP_POP3_PORT",
        document,
        "local_smtp",
        "pop3_port",
        validatedConfig.local_smtp.pop3_port ?? 0,
        context.projectEnvValues,
      );
      const analyticsPort = envPortOrConfigured(
        "SUPABASE_ANALYTICS_PORT",
        document,
        "analytics",
        "port",
        validatedConfig.analytics.port,
        context.projectEnvValues,
      );
      const poolMode =
        validatedConfig.db.pooler.pool_mode === "session" ? ("session" as const) : "transaction";
      const storagePath = `${projectRoot}/supabase/.temp/stack-uploads`;
      const createCreations = (
        stackId: string,
        options?: { readonly jwtSecret?: Redacted.Redacted<string> },
      ): Effect.Effect<ReadonlyArray<ServiceCreationType>, StackConfigError> =>
        Effect.gen(function* () {
          const effectiveJwtSecret = options?.jwtSecret ?? jwtSecret;
          if (
            options?.jwtSecret !== undefined &&
            validatedConfig.auth.jwt_secret !== undefined &&
            Redacted.value(options.jwtSecret) !== validatedConfig.auth.jwt_secret
          )
            return yield* new StackConfigError({
              message: "The configured auth.jwt_secret does not match the existing stack",
            });
          const bootstrap = validatedConfig.edge_runtime.enabled
            ? yield* typeof SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE === "string"
                ? Effect.succeed(SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE)
                : Effect.tryPromise({
                    try: () => import("./stack-functions-bundler.ts"),
                    catch: (cause) =>
                      new StackConfigError({
                        message: `Unable to load Functions bundler: ${String(cause)}`,
                      }),
                  }).pipe(
                    Effect.flatMap(({ bundleStackFunctionsServeMainTemplate }) =>
                      bundleStackFunctionsServeMainTemplate().pipe(
                        Effect.mapError(
                          (cause) => new StackConfigError({ message: cause.message }),
                        ),
                      ),
                    ),
                  )
            : undefined;
          return [
            {
              service: "database",
              config: {
                version: String(validatedConfig.db.major_version),
                databasePassword: Redacted.make("postgres"),
                jwtSecret: effectiveJwtSecret,
                jwtExpiry: validatedConfig.auth.jwt_expiry,
                settings: validatedConfig.db.settings,
              },
              endpoints: { sql: endpoint(dbPort) },
            },
            ...(validatedConfig.analytics.enabled
              ? [
                  {
                    service: "analytics" as const,
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      backend: "postgres" as const,
                    },
                    endpoints: { http: endpoint(analyticsPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.db.pooler.enabled
              ? [
                  {
                    service: "pooler" as const,
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      jwtSecret: Redacted.value(effectiveJwtSecret),
                      poolMode,
                    },
                    endpoints: { http: endpoint(undefined), sql: endpoint(poolerPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.studio.enabled
              ? [
                  {
                    service: "pgmeta" as const,
                    config: { databaseUrl: "postgresql://placeholder" },
                    endpoints: { http: endpoint(undefined) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.api.enabled
              ? [
                  {
                    service: "rest" as const,
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      schemas: validatedConfig.api.schemas.join(","),
                      maxRows: validatedConfig.api.max_rows,
                      ...(validatedConfig.api.external_url === undefined
                        ? {}
                        : { externalApiUrl: validatedConfig.api.external_url }),
                      jwtSecret: Redacted.value(effectiveJwtSecret),
                    },
                    endpoints: { http: endpoint(apiPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.auth.enabled
              ? [
                  {
                    service: "auth" as const,
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      siteUrl: validatedConfig.auth.site_url,
                      jwtSecret: Redacted.value(effectiveJwtSecret),
                      jwtExpiry: validatedConfig.auth.jwt_expiry,
                      disableSignup: !validatedConfig.auth.enable_signup,
                    },
                    endpoints: { http: endpoint(apiPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.realtime.enabled
              ? [
                  {
                    service: "realtime" as const,
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      jwtSecret: Redacted.value(effectiveJwtSecret),
                      secretKeyBase: Redacted.value(effectiveJwtSecret),
                    },
                    endpoints: {
                      http: endpoint(apiPort),
                      rpc: endpoint(undefined),
                    },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.storage.enabled
              ? [
                  {
                    service: "storage" as const,
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      jwtSecret: Redacted.value(effectiveJwtSecret),
                      filePath: `${storagePath}/${stackId}`,
                      fileSizeLimit: storageFileSizeLimit,
                    },
                    endpoints: { http: endpoint(apiPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.analytics.enabled
              ? [
                  {
                    service: "vector" as const,
                    config: { analyticsUrl: "http://analytics" },
                    endpoints: { http: endpoint(undefined) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.storage.image_transformation?.enabled === true
              ? [
                  {
                    service: "imgproxy" as const,
                    config: { filePath: `${storagePath}/${stackId}` },
                    endpoints: { http: endpoint(undefined) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.edge_runtime.enabled && bootstrap !== undefined
              ? [
                  {
                    service: "functions" as const,
                    config: {
                      functionsRoot: `${projectRoot}/supabase/functions`,
                      bootstrap,
                      policy: validatedConfig.edge_runtime.policy,
                      verifyJwt: true,
                      jwtSecret: Redacted.value(effectiveJwtSecret),
                    },
                    endpoints: { http: endpoint(apiPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.studio.enabled
              ? [
                  {
                    service: "studio" as const,
                    config: { jwtSecret: Redacted.value(effectiveJwtSecret) },
                    endpoints: { http: endpoint(studioPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.local_smtp.enabled
              ? [
                  {
                    service: "mail" as const,
                    config: {},
                    endpoints: {
                      http: endpoint(mailPort),
                      smtp: endpoint(mailSmtpPort),
                      pop3: endpoint(mailPop3Port),
                    },
                  } satisfies ServiceCreationType,
                ]
              : []),
          ];
        });
      return {
        jwtSecret,
        creations: createCreations,
        source: validatedConfig,
        projectEnvValues: context.projectEnvValues,
        ...(context.loaded?.document === undefined ? {} : { document: context.loaded.document }),
      };
    }),
);

import type { CliConfig } from "@supabase/config";
import { Effect, Data, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { StackConfigSchema, type StackConfig } from "@supabase/stack/effect";

import { loadLocalProjectContext } from "../../../command-internal/local-project-context.ts";
import { parseDotEnv } from "../../../command-internal/dotenv.ts";
import {
  envOverride,
  envOverrideApiMaxRows,
  envOverrideAuthPasswordRequirements,
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
} from "../../../command-internal/local-config-values.ts";
import {
  collectDotenvPrivateKeys,
  decryptSecret,
  isEncryptedSecret,
} from "../../../command-internal/vault-decrypt.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** A config error suitable for an experimental stack command's user-facing boundary. */
export class StackConfigError extends Data.TaggedError("StackConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

type StackConfigEffect = Effect.Effect<
  StackConfig,
  StackConfigError,
  FileSystem.FileSystem | Path.Path
>;

type JwtSigning =
  | { readonly kind: "jwks-file"; readonly path: string }
  | { readonly kind: "symmetric"; readonly secret: Redacted.Redacted<string> };

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

const secret = (value: unknown): Redacted.Redacted<string> | undefined => {
  if (Redacted.isRedacted(value)) {
    const unwrapped = Redacted.value(value);
    return typeof unwrapped === "string" ? Redacted.make(unwrapped) : undefined;
  }
  return typeof value === "string" ? Redacted.make(value) : undefined;
};

const parseEnv = (contents: string): Record<string, Redacted.Redacted<string>> =>
  Object.fromEntries(
    Object.entries(parseDotEnv(contents)).map(([key, value]) => [key, Redacted.make(value)]),
  );

const envKeyPattern = /^[A-Z_][A-Z0-9_]*$/u;
const defaultStudioApiUrl = "http://127.0.0.1";

const envString = (
  name: string,
  value: string | undefined,
  env: Readonly<Record<string, string>>,
) => envOverride(name, value, env) ?? value;
const envBool = (
  name: string,
  value: boolean,
  field: string,
  env: Readonly<Record<string, string>>,
) => envOverrideBool(name, value, field, env);
const envUint = (
  name: string,
  value: number,
  field: string,
  env: Readonly<Record<string, string>>,
) => envOverrideUint(name, field, value, env);
const envSecret = (name: string, value: unknown, env: Readonly<Record<string, string>>) => {
  const unwrapped = Redacted.isRedacted(value) ? Redacted.value(value) : undefined;
  const configured =
    typeof value === "string" ? value : typeof unwrapped === "string" ? unwrapped : undefined;
  const resolved = envString(name, configured, env);
  return resolved === undefined ? undefined : Redacted.make(resolved);
};

const envArray = (
  name: string,
  value: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): ReadonlyArray<string> => {
  const override = envOverride(name, undefined, env);
  return override === undefined ? value : override.split(",");
};

const validateEnvKeys = (
  values: Readonly<Record<string, Redacted.Redacted<string>>>,
  file: string,
) => {
  const invalid = Object.keys(values).find((key) => !envKeyPattern.test(key));
  return invalid === undefined
    ? Effect.succeed(values)
    : Effect.fail(
        new StackConfigError({
          message: `Invalid environment variable key ${invalid} in ${file}; use uppercase letters, digits, and underscores.`,
        }),
      );
};

const readFunctionEnvironments = (
  projectRoot: string,
  disabledFunctions: ReadonlySet<string> = new Set(),
  skip = false,
): Effect.Effect<
  Readonly<{
    readonly shared: Readonly<Record<string, Redacted.Redacted<string>>>;
    readonly functions: Readonly<
      Record<string, Readonly<Record<string, Redacted.Redacted<string>>>>
    >;
  }>,
  StackConfigError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(projectRoot, "supabase", "functions");
    if (skip) return { shared: {}, functions: {} };
    const read = (file: string) =>
      fs.exists(file).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs.readFileString(file).pipe(
                Effect.flatMap((contents) =>
                  Effect.try({
                    try: () => parseEnv(contents),
                    // Keep parser diagnostics free of dotenv values, which may contain secrets.
                    catch: () =>
                      new StackConfigError({
                        message: `Failed to parse environment file ${file}`,
                      }),
                  }),
                ),
                Effect.flatMap((values) => validateEnvKeys(values, file)),
              )
            : Effect.succeed({}),
        ),
      );
    const shared = yield* read(path.join(root, ".env"));
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const result: Record<string, Readonly<Record<string, Redacted.Redacted<string>>>> = {};
    for (const entry of entries.filter((name) => !name.startsWith(".") && !name.startsWith("_"))) {
      if (!/^[A-Za-z0-9_-]+$/u.test(entry)) continue;
      const info = yield* fs.stat(path.join(root, entry)).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      if (disabledFunctions.has(entry)) continue;
      const functionEnv = yield* read(path.join(root, entry, ".env"));
      result[entry] = { ...shared, ...functionEnv };
    }
    return { shared, functions: result };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof StackConfigError ? cause : new StackConfigError({ message: String(cause) }),
    ),
  );

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

const pick = (
  value: unknown,
  keys: ReadonlyArray<string>,
  secretKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in value) || value[key] === undefined) continue;
    result[key] = secretKeys.has(key) ? secret(value[key]) : value[key];
  }
  return result;
};

const envPortOrConfigured = (
  name: string,
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  key: string,
  configured: number,
  env: Readonly<Record<string, string>>,
): number | undefined => {
  if (envOverride(name, undefined, env) !== undefined)
    return envOverridePort(name, configured, `${sectionName}.${key}`, env);
  return explicitPort(document, sectionName, key);
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
  if (envOverride(name, undefined, env) !== undefined)
    return envOverridePort(name, configured, `${sectionName}.${nestedSection}.${key}`, env);
  const nested = section(section(document, sectionName), nestedSection);
  return typeof nested?.[key] === "number" ? nested[key] : undefined;
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

const stackProjectPath = (path: Path.Path, value: string): string =>
  value.length === 0 || path.isAbsolute(value)
    ? value
    : `supabase/${value.startsWith("./") ? value.slice(2) : value}`;

/** Converts a CLI function path (relative to supabase/) to the stack resolver's
 * function-directory-relative form. */
const functionRelativePath = (
  path: Path.Path,
  projectRoot: string,
  value: string,
  name: string,
): string => {
  if (value.length === 0) return value;
  const functionsRoot = path.join(projectRoot, "supabase", "functions");
  const functionRoot = path.join(functionsRoot, name);
  const target = path.isAbsolute(value)
    ? path.normalize(value)
    : path.normalize(
        path.join(projectRoot, "supabase", value.startsWith("./") ? value.slice(2) : value),
      );
  return path.relative(functionRoot, target).replaceAll(path.sep, "/");
};

const functionPathError = (
  path: Path.Path,
  projectRoot: string,
  name: string,
  field: string,
  value: string,
): string | undefined => {
  if (value.length === 0) return undefined;
  const functionsRoot = path.join(projectRoot, "supabase", "functions");
  const target = path.isAbsolute(value)
    ? path.normalize(value)
    : path.normalize(
        path.join(projectRoot, "supabase", value.startsWith("./") ? value.slice(2) : value),
      );
  const relative = path.relative(functionsRoot, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    return `functions.${name}.${field} path must be inside supabase/functions`;
  return undefined;
};

const apiListener = (
  document: Readonly<Record<string, unknown>> | undefined,
  config: CliConfig,
  portOverride?: number,
) => {
  const listener = listenerFromSection(document, "api", "port", portOverride, config.api.enabled);
  const gatewayEnabled =
    config.api.enabled ||
    config.auth.enabled ||
    config.realtime.enabled ||
    config.storage.enabled ||
    config.edge_runtime.enabled ||
    config.analytics.enabled;
  if (listener === undefined) return listener;
  if (gatewayEnabled) {
    const port = portOverride ?? explicitPort(document, "api", "port");
    return port === undefined ? {} : { port };
  }
  return { ...listener, enabled: false };
};

const listenerFromSection = (
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  portKey: string,
  portOverride?: number,
  enabledOverride?: boolean,
) => {
  const raw = section(document, sectionName);
  const port = portOverride ?? explicitPort(document, sectionName, portKey);
  if (raw === undefined) {
    if (enabledOverride === false && port !== undefined) return { enabled: false };
    return port === undefined ? undefined : { port };
  }
  const enabled =
    enabledOverride ?? (typeof raw["enabled"] === "boolean" ? raw["enabled"] : undefined);
  if (enabled === false) return { enabled: false };
  return port === undefined ? undefined : { port };
};

const nestedPort = (
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  nestedSection: string,
  portKey: string,
): number | undefined => {
  const nested = section(section(document, sectionName), nestedSection);
  const value = nested?.[portKey];
  return typeof value === "number" ? value : undefined;
};

const nestedListener = (
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  nestedSection: string,
  portKey: string,
  portOverride?: number,
  enabledOverride?: boolean,
) => {
  const parent = section(document, sectionName);
  const nested = section(parent, nestedSection);
  const port = portOverride ?? nestedPort(document, sectionName, nestedSection, portKey);
  if (nested === undefined) {
    if (enabledOverride === false && port !== undefined) return { enabled: false };
    return port === undefined ? undefined : { port };
  }
  if (enabledOverride === false || (enabledOverride === undefined && nested.enabled === false))
    return { enabled: false };
  return port === undefined ? undefined : { port };
};

const authSettings = (
  auth: CliConfig["auth"],
  document: Readonly<Record<string, unknown>> | undefined,
  env: Readonly<Record<string, string>>,
) => {
  const authDocument = section(document, "auth");
  const resolvedEmail = resolveAuthEmail(auth.email, authDocument, env);
  const resolvedSmtp = resolveAuthEmailSmtp(authDocument, env);
  const resolvedMfa = resolveAuthMfa(auth.mfa, env);
  const resolvedSms = resolveAuthSms(authDocument, auth.sms, env);
  const resolvedExternal = resolveAuthExternalProviders(authDocument, auth.external, env);
  const resolvedHooks = resolveAuthHooks(authDocument, auth.hook, env);
  const resolvedCaptcha = resolveAuthCaptcha(authDocument, auth.captcha, env);
  const resolvedSessions = resolveGotrueSessions(auth.sessions, env);
  const resolvedRateLimit = resolveGotrueRateLimit(auth.rate_limit, env);
  const resolvedWeb3 = resolveGotrueWeb3(auth.web3, env);
  const resolvedOAuthServer = resolveGotrueOAuthServer(auth.oauth_server, env);
  const passwordRequirements = envOverrideAuthPasswordRequirements(auth.password_requirements, env);
  const thirdParty = {
    firebase: {
      enabled: envBool(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
        auth.third_party.firebase.enabled,
        "auth.third_party.firebase.enabled",
        env,
      ),
      project_id: envString(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID",
        auth.third_party.firebase.project_id,
        env,
      ),
    },
    auth0: {
      enabled: envBool(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_ENABLED",
        auth.third_party.auth0.enabled,
        "auth.third_party.auth0.enabled",
        env,
      ),
      tenant: envString(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT",
        auth.third_party.auth0.tenant,
        env,
      ),
      tenant_region: envString(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT_REGION",
        auth.third_party.auth0.tenant_region,
        env,
      ),
    },
    aws_cognito: {
      enabled: envBool(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_ENABLED",
        auth.third_party.aws_cognito.enabled,
        "auth.third_party.aws_cognito.enabled",
        env,
      ),
      user_pool_id: envString(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
        auth.third_party.aws_cognito.user_pool_id,
        env,
      ),
      user_pool_region: envString(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_REGION",
        auth.third_party.aws_cognito.user_pool_region,
        env,
      ),
    },
    clerk: {
      enabled: envBool(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
        auth.third_party.clerk.enabled,
        "auth.third_party.clerk.enabled",
        env,
      ),
      domain: envString(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
        auth.third_party.clerk.domain,
        env,
      ),
    },
    workos: {
      enabled: envBool(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
        auth.third_party.workos.enabled,
        "auth.third_party.workos.enabled",
        env,
      ),
      issuer_url: envString(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
        auth.third_party.workos.issuer_url,
        env,
      ),
    },
  };

  const hooks: Record<string, unknown> = {};
  const hookDocument = section(authDocument, "hook");
  const hookValues = {
    mfa_verification_attempt: resolvedHooks.mfaVerificationAttempt,
    password_verification_attempt: resolvedHooks.passwordVerificationAttempt,
    custom_access_token: resolvedHooks.customAccessToken,
    send_sms: resolvedHooks.sendSms,
    send_email: resolvedHooks.sendEmail,
    before_user_created: resolvedHooks.beforeUserCreated,
  };
  for (const [name, resolved] of Object.entries(hookValues)) {
    if (hookDocument?.[name] === undefined) continue;
    hooks[name] = {
      enabled: resolved.enabled,
      ...(resolved.uri.length === 0 ? {} : { uri: resolved.uri }),
      ...(resolved.secrets.length === 0 ? {} : { secrets: Redacted.make(resolved.secrets) }),
    };
  }

  const external: Record<string, unknown> = {};
  const externalDocument = section(authDocument, "external");
  for (const name of authProviderNames) {
    const resolved = resolvedExternal[name];
    if (
      resolved === undefined ||
      auth.external[name] === undefined ||
      externalDocument?.[name] === undefined
    )
      continue;
    external[name] = {
      enabled: resolved.enabled,
      client_id: resolved.clientId,
      secret: resolved.secret === undefined ? undefined : Redacted.make(resolved.secret),
      url: resolved.url,
      redirect_uri: resolved.redirectUri,
      skip_nonce_check: resolved.skipNonceCheck,
      email_optional: resolved.emailOptional,
    };
  }

  const provider = (value: Record<string, unknown>) => value;
  const sms = {
    ...pick(resolvedSms, ["enable_signup", "enable_confirmations", "template", "max_frequency"]),
    twilio: provider({
      enabled: resolvedSms.twilio.enabled,
      account_sid: resolvedSms.twilio.account_sid,
      message_service_sid: resolvedSms.twilio.message_service_sid,
      auth_token: secret(resolvedSms.twilio.auth_token),
    }),
    twilio_verify: provider({
      enabled: resolvedSms.twilio_verify.enabled,
      account_sid: resolvedSms.twilio_verify.account_sid,
      message_service_sid: resolvedSms.twilio_verify.message_service_sid,
      auth_token: secret(resolvedSms.twilio_verify.auth_token),
    }),
    messagebird: provider({
      enabled: resolvedSms.messagebird.enabled,
      originator: resolvedSms.messagebird.originator,
      access_key: secret(resolvedSms.messagebird.access_key),
    }),
    textlocal: provider({
      enabled: resolvedSms.textlocal.enabled,
      sender: resolvedSms.textlocal.sender,
      api_key: secret(resolvedSms.textlocal.api_key),
    }),
    vonage: provider({
      enabled: resolvedSms.vonage.enabled,
      from: resolvedSms.vonage.from,
      api_key: resolvedSms.vonage.api_key,
      api_secret: secret(resolvedSms.vonage.api_secret),
    }),
    ...(auth.sms.test_otp === undefined ? {} : { test_otp: auth.sms.test_otp }),
  };

  const email = {
    enable_signup: resolvedEmail.enable_signup,
    double_confirm_changes: resolvedEmail.double_confirm_changes,
    enable_confirmations: resolvedEmail.enable_confirmations,
    secure_password_change: resolvedEmail.secure_password_change,
    max_frequency: resolvedEmail.max_frequency,
    otp_length: resolvedEmail.otp_length,
    otp_expiry: resolvedEmail.otp_expiry,
    ...(resolvedSmtp === undefined
      ? {}
      : {
          smtp: {
            enabled: resolvedSmtp.enabled,
            host: resolvedSmtp.host,
            port: resolvedSmtp.port,
            user: resolvedSmtp.user,
            pass: Redacted.make(resolvedSmtp.pass),
            admin_email: resolvedSmtp.adminEmail,
            sender_name: resolvedSmtp.senderName,
          },
        }),
    template: Object.fromEntries(
      Object.entries(resolvedEmail.template).map(([name, value]) => [
        name,
        pick(value, ["subject", "content_path"]),
      ]),
    ),
    notification: Object.fromEntries(
      Object.entries(resolvedEmail.notification).map(([name, value]) => [
        name,
        pick(value, ["enabled", "subject", "content_path"]),
      ]),
    ),
  };

  return {
    site_url: envString("SUPABASE_AUTH_SITE_URL", auth.site_url, env),
    additional_redirect_urls: envArray(
      "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
      auth.additional_redirect_urls,
      env,
    ),
    jwt_expiry: envUint("SUPABASE_AUTH_JWT_EXPIRY", auth.jwt_expiry, "auth.jwt_expiry", env),
    jwt_issuer: envString("SUPABASE_AUTH_JWT_ISSUER", auth.jwt_issuer, env),
    signing_keys_path: auth.signing_keys_path,
    enable_refresh_token_rotation: envBool(
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      auth.enable_refresh_token_rotation,
      "auth.enable_refresh_token_rotation",
      env,
    ),
    refresh_token_reuse_interval: envUint(
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      auth.refresh_token_reuse_interval,
      "auth.refresh_token_reuse_interval",
      env,
    ),
    enable_manual_linking: envBool(
      "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
      auth.enable_manual_linking,
      "auth.enable_manual_linking",
      env,
    ),
    enable_signup: envBool(
      "SUPABASE_AUTH_ENABLE_SIGNUP",
      auth.enable_signup,
      "auth.enable_signup",
      env,
    ),
    enable_anonymous_sign_ins: envBool(
      "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
      auth.enable_anonymous_sign_ins,
      "auth.enable_anonymous_sign_ins",
      env,
    ),
    minimum_password_length: envUint(
      "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
      auth.minimum_password_length,
      "auth.minimum_password_length",
      env,
    ),
    password_requirements: passwordRequirements,
    publishable_key: envSecret("SUPABASE_AUTH_PUBLISHABLE_KEY", auth.publishable_key, env),
    secret_key: envSecret("SUPABASE_AUTH_SECRET_KEY", auth.secret_key, env),
    jwt_secret: envSecret("SUPABASE_AUTH_JWT_SECRET", auth.jwt_secret, env),
    anon_key: envSecret("SUPABASE_AUTH_ANON_KEY", auth.anon_key, env),
    service_role_key: envSecret("SUPABASE_AUTH_SERVICE_ROLE_KEY", auth.service_role_key, env),
    rate_limit: resolvedRateLimit,
    ...(resolvedCaptcha === undefined
      ? {}
      : {
          captcha: {
            enabled: resolvedCaptcha.enabled,
            provider: resolvedCaptcha.provider,
            secret:
              resolvedCaptcha.secret === undefined
                ? undefined
                : Redacted.make(resolvedCaptcha.secret),
          },
        }),
    hook: hooks,
    mfa: resolvedMfa,
    sessions: resolvedSessions,
    email,
    sms,
    external,
    web3: resolvedWeb3,
    oauth_server: resolvedOAuthServer,
    third_party: thirdParty,
  };
};

const functionsSettings = (
  projectRoot: string,
  path: Path.Path,
  config: CliConfig,
  document?: Record<string, unknown>,
  projectEnvValues: Readonly<Record<string, string>> = {},
) => {
  const edge = config.edge_runtime;
  const edgePolicy = envOverrideEdgeRuntimePolicy(edge.policy, projectEnvValues);
  const edgeDenoVersion = envOverrideDenoVersion(edge.deno_version, projectEnvValues);
  const documentFunctions = section(document, "functions");
  const functions = Object.fromEntries(
    Object.entries(config.functions).map(([name, value]) => [
      name,
      {
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
        ...(value.verify_jwt === undefined ? {} : { verify_jwt: value.verify_jwt }),
        ...(value.import_map === undefined
          ? {}
          : { import_map: functionRelativePath(path, projectRoot, value.import_map, name) }),
        ...(value.entrypoint === undefined
          ? {}
          : { entrypoint: functionRelativePath(path, projectRoot, value.entrypoint, name) }),
        ...(value.static_files === undefined
          ? {}
          : {
              static_files: value.static_files.map((filePath) =>
                functionRelativePath(path, projectRoot, filePath, name),
              ),
            }),
        env: Object.fromEntries(
          Object.entries(
            isRecord(documentFunctions?.[name]) && isRecord(documentFunctions[name].env)
              ? documentFunctions[name].env
              : value.env,
          ).flatMap(([key, item]) => {
            const resolvedValue =
              typeof item === "string" && /^env\([A-Za-z_][A-Za-z0-9_]*\)$/.test(item)
                ? projectEnvValues[item.slice(4, -1)]
                : item;
            const resolved = secret(resolvedValue);
            return resolved === undefined ? [] : [[key, resolved]];
          }),
        ),
      },
    ]),
  );
  return {
    functions_root: "supabase/functions",
    edge_runtime: {
      ...(edgePolicy === undefined ? {} : { policy: edgePolicy }),
      ...(edgeDenoVersion === undefined ? {} : { deno_version: edgeDenoVersion }),
      ...(edge.secrets === undefined
        ? {}
        : {
            secrets: Object.fromEntries(
              Object.entries(edge.secrets).flatMap(([key, item]) => {
                const resolved = secret(item);
                return resolved === undefined ? [] : [[key, resolved]];
              }),
            ),
          }),
    },
    functions,
  };
};

const configInput = (
  projectRoot: string,
  path: Path.Path,
  config: CliConfig,
  document?: Record<string, unknown>,
  projectEnvValues: Readonly<Record<string, string>> = {},
  effectiveEdgeEnabled?: boolean,
) => {
  const db = config.db;
  const api = config.api;
  const auth = config.auth;
  const storage = config.storage;
  const realtime = config.realtime;
  const studio = config.studio;
  const analytics = config.analytics;
  const mail = config.local_smtp;
  const pooler = db.pooler;
  const apiEnabled = envBool("SUPABASE_API_ENABLED", api.enabled, "api.enabled", projectEnvValues);
  const apiSchemas = envArray("SUPABASE_API_SCHEMAS", api.schemas, projectEnvValues);
  const apiExtraSearchPath = envArray(
    "SUPABASE_API_EXTRA_SEARCH_PATH",
    api.extra_search_path,
    projectEnvValues,
  );
  const apiMaxRows = envOverrideApiMaxRows(api.max_rows, projectEnvValues);
  const apiTls = {
    enabled: envBool(
      "SUPABASE_API_TLS_ENABLED",
      api.tls.enabled,
      "api.tls.enabled",
      projectEnvValues,
    ),
    cert_path: envString("SUPABASE_API_TLS_CERT_PATH", api.tls.cert_path, projectEnvValues),
    key_path: envString("SUPABASE_API_TLS_KEY_PATH", api.tls.key_path, projectEnvValues),
  };
  const apiResolved = {
    ...api,
    enabled: apiEnabled,
    schemas: apiSchemas,
    extra_search_path: apiExtraSearchPath,
    max_rows: apiMaxRows,
    tls: apiTls,
    external_url: envString("SUPABASE_API_EXTERNAL_URL", api.external_url, projectEnvValues),
  };
  const dbPort = envPortOrConfigured(
    "SUPABASE_DB_PORT",
    document,
    "db",
    "port",
    db.port,
    projectEnvValues,
  );
  const dbMajorVersion = envOverrideMajorVersion(db.major_version, projectEnvValues);
  const resolvedDbSettings = resolveDbSettingsEnvOverrides(db.settings, projectEnvValues);
  const {
    session_replication_role: dbSessionReplicationRole,
    ...dbSettingsWithoutSessionReplicationRole
  } = resolvedDbSettings;
  const normalizeDbSessionReplicationRole = (
    value: string | undefined,
  ): "local" | "origin" | "replica" | undefined => {
    if (value === "local" || value === "origin" || value === "replica") return value;
    return undefined;
  };
  const dbSettings = {
    ...dbSettingsWithoutSessionReplicationRole,
    session_replication_role: normalizeDbSessionReplicationRole(dbSessionReplicationRole),
  };
  const realtimeResolved = {
    ...realtime,
    enabled: envBool(
      "SUPABASE_REALTIME_ENABLED",
      realtime.enabled,
      "realtime.enabled",
      projectEnvValues,
    ),
    ip_version: envOverrideRealtimeIpVersion(realtime.ip_version, projectEnvValues),
    max_header_length: envOverrideRealtimeMaxHeaderLength(
      realtime.max_header_length,
      projectEnvValues,
    ),
  };
  const storageResolved = {
    ...storage,
    enabled: envBool(
      "SUPABASE_STORAGE_ENABLED",
      storage.enabled,
      "storage.enabled",
      projectEnvValues,
    ),
    file_size_limit: envString(
      "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
      String(storage.file_size_limit),
      projectEnvValues,
    ),
    image_transformation: {
      enabled: storage.image_transformation?.enabled,
    },
    s3_protocol: {
      ...storage.s3_protocol,
      enabled: envBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        projectEnvValues,
      ),
    },
    analytics: {
      ...storage.analytics,
      enabled: envBool(
        "SUPABASE_STORAGE_ANALYTICS_ENABLED",
        storage.analytics.enabled,
        "storage.analytics.enabled",
        projectEnvValues,
      ),
      max_namespaces: envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
        "storage.analytics.max_namespaces",
        storage.analytics.max_namespaces,
        projectEnvValues,
      ),
      max_tables: envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
        "storage.analytics.max_tables",
        storage.analytics.max_tables,
        projectEnvValues,
      ),
      max_catalogs: envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
        "storage.analytics.max_catalogs",
        storage.analytics.max_catalogs,
        projectEnvValues,
      ),
    },
    vector: {
      ...storage.vector,
      enabled: envBool(
        "SUPABASE_STORAGE_VECTOR_ENABLED",
        storage.vector.enabled,
        "storage.vector.enabled",
        projectEnvValues,
      ),
      max_buckets: envOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
        "storage.vector.max_buckets",
        storage.vector.max_buckets,
        projectEnvValues,
      ),
      max_indexes: envOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
        "storage.vector.max_indexes",
        storage.vector.max_indexes,
        projectEnvValues,
      ),
    },
  };
  const edgeEnabled =
    effectiveEdgeEnabled ??
    envBool(
      "SUPABASE_EDGE_RUNTIME_ENABLED",
      config.edge_runtime.enabled,
      "edge_runtime.enabled",
      projectEnvValues,
    );
  const analyticsEnabled = envBool(
    "SUPABASE_ANALYTICS_ENABLED",
    analytics.enabled,
    "analytics.enabled",
    projectEnvValues,
  );
  const analyticsBackendValue = envOverride(
    "SUPABASE_ANALYTICS_BACKEND",
    analytics.backend,
    projectEnvValues,
  );
  const analyticsResolved = {
    ...analytics,
    enabled: analyticsEnabled,
    backend: analyticsBackendValue,
    vector_port:
      envOverridePort(
        "SUPABASE_ANALYTICS_VECTOR_PORT",
        analytics.vector_port ?? 0,
        "analytics.vector_port",
        projectEnvValues,
      ) || undefined,
    gcp_project_id: envString(
      "SUPABASE_ANALYTICS_GCP_PROJECT_ID",
      analytics.gcp_project_id,
      projectEnvValues,
    ),
    gcp_project_number: envString(
      "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
      analytics.gcp_project_number,
      projectEnvValues,
    ),
    gcp_jwt_path: envString(
      "SUPABASE_ANALYTICS_GCP_JWT_PATH",
      analytics.gcp_jwt_path,
      projectEnvValues,
    ),
  };
  const authEnabled = envBool(
    "SUPABASE_AUTH_ENABLED",
    auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  const studioEnabled = envBool(
    "SUPABASE_STUDIO_ENABLED",
    studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const studioPort = envPortOrConfigured(
    "SUPABASE_STUDIO_PORT",
    document,
    "studio",
    "port",
    studio.port,
    projectEnvValues,
  );
  const studioApiUrl = envString("SUPABASE_STUDIO_API_URL", studio.api_url, projectEnvValues);
  const mailEnabled = envBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    mail.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  const mailPort = envPortOrConfigured(
    "SUPABASE_LOCAL_SMTP_PORT",
    document,
    "local_smtp",
    "port",
    mail.port,
    projectEnvValues,
  );
  const mailSmtpPort =
    envOverridePort(
      "SUPABASE_LOCAL_SMTP_SMTP_PORT",
      mail.smtp_port ?? 0,
      "local_smtp.smtp_port",
      projectEnvValues,
    ) || undefined;
  const mailPop3Port =
    envOverridePort(
      "SUPABASE_LOCAL_SMTP_POP3_PORT",
      mail.pop3_port ?? 0,
      "local_smtp.pop3_port",
      projectEnvValues,
    ) || undefined;
  const poolerEnabled = envBool(
    "SUPABASE_DB_POOLER_ENABLED",
    pooler.enabled,
    "db.pooler.enabled",
    projectEnvValues,
  );
  const poolerPort = envNestedPortOrConfigured(
    "SUPABASE_DB_POOLER_PORT",
    document,
    "db",
    "pooler",
    "port",
    pooler.port,
    projectEnvValues,
  );
  const poolerResolved = {
    ...pooler,
    enabled: poolerEnabled,
    port: poolerPort,
    pool_mode: envOverridePoolMode(pooler.pool_mode, projectEnvValues),
    default_pool_size: envOverrideDefaultPoolSize(pooler.default_pool_size, projectEnvValues),
    max_client_conn: envOverrideMaxClientConn(pooler.max_client_conn, projectEnvValues),
  };
  const authResolvedSettings = authEnabled
    ? authSettings(auth, document, projectEnvValues)
    : undefined;
  const jwtIssuer = envString("SUPABASE_AUTH_JWT_ISSUER", auth.jwt_issuer, projectEnvValues);
  const jwtSecret = envSecret("SUPABASE_AUTH_JWT_SECRET", auth.jwt_secret, projectEnvValues);
  const jwtSigning = (): JwtSigning | undefined => {
    if (auth.signing_keys_path !== undefined)
      return {
        kind: "jwks-file",
        path: stackProjectPath(path, auth.signing_keys_path),
      };
    if (jwtSecret !== undefined) return { kind: "symmetric", secret: jwtSecret };
    return undefined;
  };
  const capability = <T>(enabled: boolean, settings: T) =>
    enabled ? { settings } : { enabled: false as const };
  return {
    capabilities: {
      database: {
        version: String(dbMajorVersion),
        settings: { health_timeout: db.health_timeout, settings: dbSettings },
      },
      rest: capability(apiResolved.enabled, {
        schemas: apiResolved.schemas,
        extra_search_path: apiResolved.extra_search_path,
        max_rows: apiResolved.max_rows,
        auto_expose_new_tables: apiResolved.auto_expose_new_tables,
        tls: apiResolved.tls,
        external_url: apiResolved.external_url,
      }),
      auth: authEnabled ? { settings: authResolvedSettings } : { enabled: false as const },
      realtime: capability(realtimeResolved.enabled, {
        ip_version: realtimeResolved.ip_version,
        max_header_length: realtimeResolved.max_header_length,
      }),
      storage: capability(storageResolved.enabled, {
        file_size_limit: storageResolved.file_size_limit,
        image_transformation: storageResolved.image_transformation,
        buckets: storageResolved.buckets,
        s3_protocol: storageResolved.s3_protocol,
        analytics: storageResolved.analytics,
        vector: storageResolved.vector,
      }),
      functions: capability(
        edgeEnabled,
        functionsSettings(projectRoot, path, config, document, projectEnvValues),
      ),
      studio: capability(studioEnabled, {
        // A host-only default must remain unset so the stack runtime can append
        // the allocated API listener port. Explicit URLs remain caller-owned.
        api_url: studioApiUrl === defaultStudioApiUrl ? undefined : studioApiUrl,
        openai_api_key: envSecret(
          "SUPABASE_STUDIO_OPENAI_API_KEY",
          studio.openai_api_key,
          projectEnvValues,
        ),
      }),
      mail: capability(mailEnabled, {
        admin_email: envString(
          "SUPABASE_LOCAL_SMTP_ADMIN_EMAIL",
          mail.admin_email,
          projectEnvValues,
        ),
        sender_name: envString(
          "SUPABASE_LOCAL_SMTP_SENDER_NAME",
          mail.sender_name,
          projectEnvValues,
        ),
      }),
      analytics: capability(analyticsEnabled, {
        backend: analyticsResolved.backend,
        vector_port: analyticsResolved.vector_port,
        gcp_project_id: analyticsResolved.gcp_project_id,
        gcp_project_number: analyticsResolved.gcp_project_number,
        gcp_jwt_path: analyticsResolved.gcp_jwt_path,
      }),
      pooler: capability(poolerEnabled, {
        pool_mode: poolerResolved.pool_mode,
        default_pool_size: poolerResolved.default_pool_size,
        max_client_conn: poolerResolved.max_client_conn,
      }),
    },
    listeners: {
      api: apiListener(
        document,
        {
          ...config,
          api: apiResolved,
          auth: { ...config.auth, enabled: authEnabled },
          realtime: { ...config.realtime, enabled: realtimeResolved.enabled },
          storage: { ...config.storage, enabled: storageResolved.enabled },
          edge_runtime: { ...config.edge_runtime, enabled: edgeEnabled },
          analytics: { ...config.analytics, enabled: analyticsEnabled },
        },
        envPortOrConfigured(
          "SUPABASE_API_PORT",
          document,
          "api",
          "port",
          api.port,
          projectEnvValues,
        ),
      ),
      database: listenerFromSection(document, "db", "port", dbPort),
      pooler: nestedListener(document, "db", "pooler", "port", poolerPort, poolerEnabled),
      studio: listenerFromSection(document, "studio", "port", studioPort, studioEnabled),
      mailUi: listenerFromSection(document, "local_smtp", "port", mailPort, mailEnabled),
      smtp: listenerFromSection(document, "local_smtp", "smtp_port", mailSmtpPort, mailEnabled),
      pop3: listenerFromSection(document, "local_smtp", "pop3_port", mailPop3Port, mailEnabled),
      functionsInspector: listenerFromSection(
        document,
        "edge_runtime",
        "inspector_port",
        envPortOrConfigured(
          "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
          document,
          "edge_runtime",
          "inspector_port",
          config.edge_runtime.inspector_port,
          projectEnvValues,
        ),
        edgeEnabled,
      ),
    },
    security: {
      jwt: {
        ...(jwtIssuer === undefined ? {} : { issuer: jwtIssuer }),
        ...(jwtSigning() === undefined ? {} : { signing: jwtSigning() }),
      },
    },
  };
};

const decryptConsumedSecrets = (
  value: unknown,
  keys: ReadonlyArray<string>,
  path = "config",
): Effect.Effect<unknown, StackConfigError> =>
  Effect.gen(function* () {
    if (Redacted.isRedacted(value)) {
      const unwrapped = Redacted.value(value);
      if (typeof unwrapped !== "string" || !isEncryptedSecret(unwrapped)) return value;
      const result = yield* Effect.try({
        try: () => decryptSecret(unwrapped, keys),
        catch: () =>
          new StackConfigError({
            message: `${path} uses an encrypted secret that could not be decrypted`,
          }),
      });
      if (!result.ok) {
        const reason = keys.length === 0 ? "missing private key" : "decryption failed";
        return yield* new StackConfigError({
          message: `${path} uses an encrypted secret that could not be decrypted: ${reason}`,
        });
      }
      return Redacted.make(result.value);
    }
    if (Array.isArray(value))
      return yield* Effect.forEach(value, (item, index) =>
        decryptConsumedSecrets(item, keys, `${path}[${index}]`),
      );
    if (!isRecord(value)) return value;
    const entries = yield* Effect.forEach(Object.entries(value), ([key, item]) =>
      decryptConsumedSecrets(item, keys, `${path}.${key}`).pipe(
        Effect.map((resolved) => [key, resolved] as const),
      ),
    );
    return Object.fromEntries(entries);
  });

const configValidationError = (
  path: Path.Path,
  projectRoot: string,
  config: CliConfig,
  document: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>>,
  effectiveEdgeEnabled: boolean,
): string | undefined => {
  const figma = config.auth.external.figma;
  if (
    figma !== undefined &&
    section(section(section(document, "auth"), "external"), "figma") !== undefined &&
    envOverrideBool(
      "SUPABASE_AUTH_EXTERNAL_FIGMA_ENABLED",
      figma.enabled,
      "auth.external.figma.enabled",
      projectEnvValues,
    )
  )
    return "auth.external.figma is enabled but unsupported by the experimental stack";
  if (!effectiveEdgeEnabled) return undefined;
  for (const [name, functionConfig] of Object.entries(config.functions)) {
    if (functionConfig.enabled === false) continue;
    for (const [field, value] of [
      ["import_map", functionConfig.import_map],
      ["entrypoint", functionConfig.entrypoint],
      ...functionConfig.static_files.map((path) => ["static_files", path] as const),
    ] as const) {
      if (typeof value !== "string") continue;
      const pathError = functionPathError(path, projectRoot, name, field, value);
      if (pathError !== undefined) return pathError;
    }
    for (const value of Object.values(functionConfig.env)) {
      if (typeof value !== "string") continue;
      const match = /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(value);
      const variable = match?.[1];
      if (variable !== undefined && projectEnvValues[variable] === undefined)
        return `functions.${name}.env references an unset environment variable ${variable}`;
    }
  }
  return undefined;
};

/** Loads and translates the effective project config for all experimental stack commands. */
export const loadStackConfig = (projectRoot: string): StackConfigEffect =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const context = yield* loadLocalProjectContext(
      projectRoot,
      (message) => new StackConfigError({ message }),
    );
    const loaded = context.loaded;
    if (loaded === null)
      return yield* new StackConfigError({
        message: `No Supabase project configuration found in ${projectRoot}. Run supabase init first.`,
      });

    const edgeEnabled = yield* Effect.try({
      try: () =>
        envOverrideBool(
          "SUPABASE_EDGE_RUNTIME_ENABLED",
          context.config.edge_runtime.enabled,
          "edge_runtime.enabled",
          context.projectEnvValues,
        ),
      catch: (cause) =>
        new StackConfigError({
          message:
            cause instanceof Error ? cause.message : "invalid config for edge_runtime.enabled",
        }),
    });
    const validationError = yield* Effect.try({
      try: () =>
        configValidationError(
          path,
          projectRoot,
          context.config,
          loaded.document,
          context.projectEnvValues,
          edgeEnabled,
        ),
      catch: (cause) =>
        new StackConfigError({
          message: cause instanceof Error ? cause.message : "invalid stack config",
        }),
    });
    if (validationError !== undefined)
      return yield* new StackConfigError({ message: validationError });

    const environments = yield* readFunctionEnvironments(
      projectRoot,
      new Set(
        Object.entries(context.config.functions)
          .filter(([, functionConfig]) => functionConfig.enabled === false)
          .map(([name]) => name),
      ),
      !edgeEnabled,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof StackConfigError
          ? cause
          : new StackConfigError({ message: String(cause) }),
      ),
    );
    const input = yield* Effect.try({
      try: () =>
        configInput(
          projectRoot,
          path,
          context.config,
          loaded.document,
          context.projectEnvValues,
          edgeEnabled,
        ),
      catch: (cause) =>
        new StackConfigError({
          message:
            cause instanceof StackConfigError
              ? cause.message
              : cause instanceof Error
                ? cause.message
                : "invalid stack config",
        }),
    });
    const functionSettings: Readonly<Record<string, unknown>> = isRecord(
      input.capabilities.functions.settings,
    )
      ? input.capabilities.functions.settings
      : {};
    const functions = isRecord(functionSettings?.functions) ? functionSettings.functions : {};
    const allFunctions = {
      ...Object.fromEntries(
        Object.keys(environments.functions).map((name) => [
          name,
          { env: environments.functions[name] },
        ]),
      ),
      ...functions,
    };
    const mergedInput =
      input.capabilities.functions.enabled === false
        ? input
        : {
            ...input,
            capabilities: {
              ...input.capabilities,
              functions: {
                ...input.capabilities.functions,
                settings: {
                  ...functionSettings,
                  edge_runtime: {
                    ...(isRecord(functionSettings?.edge_runtime)
                      ? functionSettings.edge_runtime
                      : {}),
                    secrets: {
                      ...environments.shared,
                      ...(isRecord(functionSettings?.edge_runtime) &&
                      isRecord(functionSettings.edge_runtime.secrets)
                        ? functionSettings.edge_runtime.secrets
                        : {}),
                    },
                  },
                  functions: Object.fromEntries(
                    Object.entries(allFunctions).map(([name, value]) => [
                      name,
                      {
                        ...(isRecord(value) ? value : {}),
                        env: {
                          ...environments.functions[name],
                          ...(isRecord(value) && isRecord(value.env) ? value.env : {}),
                        },
                      },
                    ]),
                  ),
                },
              },
            },
          };
    const dotenvPrivateKeys = collectDotenvPrivateKeys({
      ...context.projectEnvValues,
      ...process.env,
    });
    const decrypted = yield* decryptConsumedSecrets(mergedInput, dotenvPrivateKeys);
    return yield* Schema.decodeUnknownEffect(StackConfigSchema)(withoutUndefined(decrypted), {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StackConfigError({
            message: `invalid stack config: ${String(cause)}`,
          }),
      ),
    );
  });

import { type CliConfig, validateCliConfig } from "@supabase/config/effect";
import { Effect, Data, FileSystem, Option, Path, Redacted, Schema, SchemaIssue } from "effect";
import { StackConfigSchema, type StackConfig } from "@supabase/stack/effect";

import { loadLocalProjectContext } from "../../../command-internal/local-project-context.ts";
import { parseDotEnv } from "../../../command-internal/dotenv.ts";
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
) => {
  const authDocument = section(document, "auth");
  const resolvedEmail = auth.email;
  const resolvedSmtp = section(authDocument && section(authDocument, "email"), "smtp")
    ? auth.email.smtp
    : undefined;
  const resolvedMfa = auth.mfa;
  const resolvedSms = auth.sms;
  const resolvedExternal = auth.external;
  const resolvedHooks = auth.hook;
  const resolvedCaptcha = auth.captcha;
  const resolvedSessions = auth.sessions;
  const resolvedRateLimit = auth.rate_limit;
  const resolvedWeb3 = auth.web3;
  const resolvedOAuthServer = auth.oauth_server;
  const passwordRequirements = auth.password_requirements;
  const thirdParty = auth.third_party;

  const hooks: Record<
    string,
    { enabled: boolean; uri?: string; secrets?: Redacted.Redacted<string> }
  > = {};
  const hookDocument = section(authDocument, "hook");
  const hookValues = {
    mfa_verification_attempt: resolvedHooks.mfa_verification_attempt,
    password_verification_attempt: resolvedHooks.password_verification_attempt,
    custom_access_token: resolvedHooks.custom_access_token,
    send_sms: resolvedHooks.send_sms,
    send_email: resolvedHooks.send_email,
    before_user_created: resolvedHooks.before_user_created,
  };
  for (const [name, resolved] of Object.entries(hookValues)) {
    if (hookDocument?.[name] === undefined) continue;
    hooks[name] = {
      enabled: resolved.enabled,
      ...(resolved.uri === undefined || resolved.uri.length === 0 ? {} : { uri: resolved.uri }),
      ...(resolved.secrets === undefined || resolved.secrets.length === 0
        ? {}
        : { secrets: secret(resolved.secrets) }),
    };
  }

  const external: Record<string, unknown> = {};
  const externalDocument = section(authDocument, "external");
  for (const name of authProviderNames) {
    const resolved = resolvedExternal[name];
    if (
      resolved === undefined ||
      auth.external[name] === undefined ||
      (name !== "apple" && externalDocument?.[name] === undefined)
    )
      continue;
    external[name] = {
      enabled: resolved.enabled,
      client_id: resolved.client_id,
      secret: secret(resolved.secret),
      url: resolved.url,
      redirect_uri: resolved.redirect_uri,
      skip_nonce_check: resolved.skip_nonce_check,
      email_optional: resolved.email_optional,
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
      api_key: secret(resolvedSms.vonage.api_key),
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
            ...(resolvedSmtp.port === 0 ? {} : { port: resolvedSmtp.port }),
            user: resolvedSmtp.user,
            pass: secret(resolvedSmtp.pass),
            admin_email: resolvedSmtp.admin_email,
            sender_name: resolvedSmtp.sender_name,
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
    site_url: auth.site_url,
    additional_redirect_urls: auth.additional_redirect_urls,
    jwt_expiry: auth.jwt_expiry,
    jwt_issuer: auth.jwt_issuer,
    signing_keys_path: auth.signing_keys_path,
    enable_refresh_token_rotation: auth.enable_refresh_token_rotation,
    refresh_token_reuse_interval: auth.refresh_token_reuse_interval,
    enable_manual_linking: auth.enable_manual_linking,
    enable_signup: auth.enable_signup,
    enable_anonymous_sign_ins: auth.enable_anonymous_sign_ins,
    minimum_password_length: auth.minimum_password_length,
    password_requirements: passwordRequirements,
    publishable_key: secret(auth.publishable_key),
    secret_key: secret(auth.secret_key),
    jwt_secret: secret(auth.jwt_secret),
    anon_key: secret(auth.anon_key),
    service_role_key: secret(auth.service_role_key),
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
  const edgePolicy = edge.policy;
  const edgeDenoVersion = edge.deno_version;
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
  const resolvedSmtp =
    smtp === undefined
      ? undefined
      : {
          enabled: smtp.enabled,
          host: smtp.host,
          port: smtp.port,
          user: smtp.user,
          pass: smtp.pass,
          admin_email: smtp.adminEmail,
          sender_name: smtp.senderName,
        };
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
  return {
    ...auth,
    enabled: envBool("SUPABASE_AUTH_ENABLED", auth.enabled, "auth.enabled", env),
    site_url: envString("SUPABASE_AUTH_SITE_URL", auth.site_url, env) ?? auth.site_url,
    additional_redirect_urls: envArray(
      "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
      auth.additional_redirect_urls,
      env,
    ),
    jwt_expiry: envUint("SUPABASE_AUTH_JWT_EXPIRY", auth.jwt_expiry, "auth.jwt_expiry", env),
    jwt_issuer: envString("SUPABASE_AUTH_JWT_ISSUER", auth.jwt_issuer, env),
    signing_keys_path: envString("SUPABASE_AUTH_SIGNING_KEYS_PATH", auth.signing_keys_path, env),
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
    password_requirements: envOverrideAuthPasswordRequirements(auth.password_requirements, env),
    publishable_key: envString("SUPABASE_AUTH_PUBLISHABLE_KEY", auth.publishable_key, env),
    secret_key: envString("SUPABASE_AUTH_SECRET_KEY", auth.secret_key, env),
    jwt_secret: envString("SUPABASE_AUTH_JWT_SECRET", auth.jwt_secret, env),
    anon_key: envString("SUPABASE_AUTH_ANON_KEY", auth.anon_key, env),
    service_role_key: envString("SUPABASE_AUTH_SERVICE_ROLE_KEY", auth.service_role_key, env),
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
  const imagePresent = section(section(document, "storage"), "image_transformation") !== undefined;
  const resolvedApi = {
    ...api,
    enabled: envBool("SUPABASE_API_ENABLED", api.enabled, "api.enabled", env),
    port: resolvedPort("SUPABASE_API_PORT", api.port, "api.port", env),
    schemas: envArray("SUPABASE_API_SCHEMAS", api.schemas, env),
    extra_search_path: envArray("SUPABASE_API_EXTRA_SEARCH_PATH", api.extra_search_path, env),
    max_rows: envOverrideApiMaxRows(api.max_rows, env),
    tls: {
      ...api.tls,
      enabled: envBool("SUPABASE_API_TLS_ENABLED", api.tls.enabled, "api.tls.enabled", env),
      cert_path: envString("SUPABASE_API_TLS_CERT_PATH", api.tls.cert_path, env),
      key_path: envString("SUPABASE_API_TLS_KEY_PATH", api.tls.key_path, env),
    },
    external_url: envString("SUPABASE_API_EXTERNAL_URL", api.external_url, env),
    auto_expose_new_tables:
      api.auto_expose_new_tables !== undefined ||
      envOverride("SUPABASE_API_AUTO_EXPOSE_NEW_TABLES", undefined, env) !== undefined
        ? envBool(
            "SUPABASE_API_AUTO_EXPOSE_NEW_TABLES",
            api.auto_expose_new_tables ?? false,
            "api.auto_expose_new_tables",
            env,
          )
        : undefined,
  };
  const resolvedStorage = {
    ...storage,
    enabled: envBool("SUPABASE_STORAGE_ENABLED", storage.enabled, "storage.enabled", env),
    file_size_limit:
      envString("SUPABASE_STORAGE_FILE_SIZE_LIMIT", String(storage.file_size_limit), env) ??
      String(storage.file_size_limit),
    image_transformation: imagePresent
      ? {
          ...storage.image_transformation,
          enabled: envBool(
            "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
            storage.image_transformation?.enabled ?? false,
            "storage.image_transformation.enabled",
            env,
          ),
        }
      : undefined,
    s3_protocol: {
      ...storage.s3_protocol,
      enabled: envBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        env,
      ),
    },
    analytics: {
      ...storage.analytics,
      enabled: envBool(
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
      enabled: envBool(
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
    enabled: envBool("SUPABASE_EDGE_RUNTIME_ENABLED", edge.enabled, "edge_runtime.enabled", env),
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
    enabled: envBool("SUPABASE_ANALYTICS_ENABLED", analytics.enabled, "analytics.enabled", env),
    backend: envOverrideAnalyticsBackend(analytics.backend, env),
    vector_port:
      resolvedPort(
        "SUPABASE_ANALYTICS_VECTOR_PORT",
        analytics.vector_port ?? 0,
        "analytics.vector_port",
        env,
      ) || undefined,
    gcp_project_id: envString("SUPABASE_ANALYTICS_GCP_PROJECT_ID", analytics.gcp_project_id, env),
    gcp_project_number: envString(
      "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
      analytics.gcp_project_number,
      env,
    ),
    gcp_jwt_path: envString("SUPABASE_ANALYTICS_GCP_JWT_PATH", analytics.gcp_jwt_path, env),
  };
  const resolvedPooler = {
    ...pooler,
    enabled: envBool("SUPABASE_DB_POOLER_ENABLED", pooler.enabled, "db.pooler.enabled", env),
    port: resolvedPort("SUPABASE_DB_POOLER_PORT", pooler.port, "db.pooler.port", env),
    pool_mode: envOverridePoolMode(pooler.pool_mode, env),
    default_pool_size: envOverrideDefaultPoolSize(pooler.default_pool_size, env),
    max_client_conn: envOverrideMaxClientConn(pooler.max_client_conn, env),
  };
  const authEnabled = envBool("SUPABASE_AUTH_ENABLED", config.auth.enabled, "auth.enabled", env);
  return {
    ...config,
    api: resolvedApi,
    auth: authEnabled
      ? resolveAuthOverrides(config.auth, document, env)
      : { ...config.auth, enabled: false },
    db: {
      ...db,
      port: resolvedPort("SUPABASE_DB_PORT", db.port, "db.port", env),
      major_version: envOverrideMajorVersion(db.major_version, env),
      health_timeout:
        envString("SUPABASE_DB_HEALTH_TIMEOUT", db.health_timeout, env) ?? db.health_timeout,
      settings: resolveDbSettingsEnvOverrides(db.settings, env),
      pooler: resolvedPooler,
    },
    edge_runtime: resolvedEdge,
    realtime: {
      ...realtime,
      enabled: envBool("SUPABASE_REALTIME_ENABLED", realtime.enabled, "realtime.enabled", env),
      ip_version: envOverrideRealtimeIpVersion(realtime.ip_version, env),
      max_header_length: envOverrideRealtimeMaxHeaderLength(realtime.max_header_length, env),
    },
    storage: resolvedStorage,
    analytics: resolvedAnalytics,
    studio: {
      ...studio,
      enabled: envBool("SUPABASE_STUDIO_ENABLED", studio.enabled, "studio.enabled", env),
      port: resolvedPort("SUPABASE_STUDIO_PORT", studio.port, "studio.port", env),
      api_url: envString("SUPABASE_STUDIO_API_URL", studio.api_url, env) ?? studio.api_url,
      openai_api_key: envString("SUPABASE_STUDIO_OPENAI_API_KEY", studio.openai_api_key, env),
    },
    local_smtp: {
      ...mail,
      enabled: envBool("SUPABASE_LOCAL_SMTP_ENABLED", mail.enabled, "local_smtp.enabled", env),
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
      admin_email: envString("SUPABASE_LOCAL_SMTP_ADMIN_EMAIL", mail.admin_email, env),
      sender_name: envString("SUPABASE_LOCAL_SMTP_SENDER_NAME", mail.sender_name, env),
    },
  };
};

const configInput = (
  projectRoot: string,
  path: Path.Path,
  config: CliConfig,
  document?: Record<string, unknown>,
  listenerEnvValues: Readonly<Record<string, string>> = {},
) => {
  // The config has already been resolved and validated. Keep the environment
  // separate here only for listener explicitness and deferred function env().
  const db = config.db;
  const api = config.api;
  const auth = config.auth;
  const storage = config.storage;
  const realtime = config.realtime;
  const studio = config.studio;
  const analytics = config.analytics;
  const mail = config.local_smtp;
  const pooler = db.pooler;
  const apiResolved = api;
  const dbPort = envPortOrConfigured(
    "SUPABASE_DB_PORT",
    document,
    "db",
    "port",
    db.port,
    listenerEnvValues,
  );
  const dbMajorVersion = db.major_version;
  const dbSettings = db.settings;
  const realtimeResolved = realtime;
  const imageTransformationPresent =
    section(section(document, "storage"), "image_transformation") !== undefined;
  const storageResolved = imageTransformationPresent
    ? storage
    : { ...storage, image_transformation: undefined };
  const edgeEnabled = config.edge_runtime.enabled;
  const analyticsEnabled = analytics.enabled;
  const analyticsResolved = analytics;
  const authEnabled = auth.enabled;
  const studioEnabled = studio.enabled;
  const studioPort = envPortOrConfigured(
    "SUPABASE_STUDIO_PORT",
    document,
    "studio",
    "port",
    studio.port,
    listenerEnvValues,
  );
  const studioApiUrl = studio.api_url;
  const mailEnabled = mail.enabled;
  const mailPort = envPortOrConfigured(
    "SUPABASE_LOCAL_SMTP_PORT",
    document,
    "local_smtp",
    "port",
    mail.port,
    listenerEnvValues,
  );
  const mailSmtpPort = envPortOrConfigured(
    "SUPABASE_LOCAL_SMTP_SMTP_PORT",
    document,
    "local_smtp",
    "smtp_port",
    mail.smtp_port ?? 0,
    listenerEnvValues,
  );
  const mailPop3Port = envPortOrConfigured(
    "SUPABASE_LOCAL_SMTP_POP3_PORT",
    document,
    "local_smtp",
    "pop3_port",
    mail.pop3_port ?? 0,
    listenerEnvValues,
  );
  const poolerEnabled = pooler.enabled;
  const poolerPort = envNestedPortOrConfigured(
    "SUPABASE_DB_POOLER_PORT",
    document,
    "db",
    "pooler",
    "port",
    pooler.port,
    listenerEnvValues,
  );
  const poolerResolved = pooler;
  const signingKeysPath = auth.signing_keys_path;
  const authResolvedSettings = authEnabled ? authSettings(auth, document) : undefined;
  const jwtIssuer = auth.jwt_issuer;
  const jwtSecret = secret(auth.jwt_secret);
  const jwtSigning = (): JwtSigning | undefined => {
    if (signingKeysPath !== undefined)
      return {
        kind: "jwks-file",
        path: stackProjectPath(path, signingKeysPath),
      };
    if (jwtSecret !== undefined) return { kind: "symmetric", secret: jwtSecret };
    return undefined;
  };
  const signing = jwtSigning();
  const capability = <T>(enabled: boolean, settings: T) =>
    enabled ? { settings } : { enabled: false as const };
  return {
    capabilities: {
      database: {
        version: String(dbMajorVersion),
        settings: {
          health_timeout: db.health_timeout,
          settings: dbSettings,
        },
      },
      rest: capability(apiResolved.enabled, {
        schemas: apiResolved.schemas,
        extra_search_path: apiResolved.extra_search_path,
        max_rows: apiResolved.max_rows,
        ...(apiResolved.auto_expose_new_tables === undefined
          ? {}
          : { auto_expose_new_tables: apiResolved.auto_expose_new_tables }),
        tls: apiResolved.tls,
        external_url: apiResolved.external_url,
      }),
      auth:
        authResolvedSettings === undefined
          ? { enabled: false as const }
          : { settings: { ...authResolvedSettings, signing_keys_path: signingKeysPath } },
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
        functionsSettings(projectRoot, path, config, document, listenerEnvValues),
      ),
      studio: capability(studioEnabled, {
        // A host-only default must remain unset so the stack runtime can append
        // the allocated API listener port. Explicit URLs remain caller-owned.
        api_url: studioApiUrl === defaultStudioApiUrl ? undefined : studioApiUrl,
        openai_api_key: secret(studio.openai_api_key),
      }),
      mail: capability(mailEnabled, {
        admin_email: mail.admin_email,
        sender_name: mail.sender_name,
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
        config,
        envPortOrConfigured(
          "SUPABASE_API_PORT",
          document,
          "api",
          "port",
          api.port,
          listenerEnvValues,
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
          listenerEnvValues,
        ),
        edgeEnabled,
      ),
    },
    security: {
      jwt: {
        ...(jwtIssuer === undefined ? {} : { issuer: jwtIssuer }),
        ...(signing === undefined ? {} : { signing }),
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
  projectEnvValues: Readonly<Record<string, string>>,
  effectiveEdgeEnabled: boolean,
): string | undefined => {
  const figma = config.auth.external.figma;
  if (config.auth.enabled && figma?.enabled === true)
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

    const effectiveInput = yield* Effect.try({
      try: () =>
        resolveEffectiveCliConfig(context.config, loaded.document, context.projectEnvValues),
      catch: (cause) =>
        new StackConfigError({
          message: cause instanceof Error ? cause.message : "invalid config overrides",
        }),
    });
    const dotenvPrivateKeys = collectDotenvPrivateKeys(context.projectEnvValues);
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
    const validationError = yield* Effect.try({
      try: () =>
        configValidationError(
          path,
          projectRoot,
          validatedConfig,
          context.projectEnvValues,
          validatedConfig.edge_runtime.enabled,
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
        Object.entries(validatedConfig.functions)
          .filter(([, functionConfig]) => functionConfig.enabled === false)
          .map(([name]) => name),
      ),
      !validatedConfig.edge_runtime.enabled,
    );
    const input = yield* Effect.try({
      try: () =>
        configInput(projectRoot, path, validatedConfig, loaded.document, context.projectEnvValues),
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
    const decrypted = yield* decryptConsumedSecrets(mergedInput, dotenvPrivateKeys);
    const decoded = yield* Schema.decodeUnknownEffect(StackConfigSchema)(
      withoutUndefined(decrypted),
      {
        onExcessProperty: "error",
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new StackConfigError({
            message: `invalid stack config: ${String(cause)}`,
          }),
      ),
    );
    return decoded;
  });

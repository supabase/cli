import type { CliConfig } from "@supabase/config";
import { Effect, Data, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { StackConfigSchema, type StackConfig } from "@supabase/stack/effect";

import { loadLocalProjectContext } from "../../../command-internal/local-project-context.ts";
import { parseDotEnv } from "../../../command-internal/dotenv.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** A config error suitable for a stack command's user-facing boundary. */
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
) =>
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
  });

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

const pickRecord = (
  value: unknown,
  keys: ReadonlyArray<string>,
  secretKeys: ReadonlySet<string> = new Set(),
): Record<string, Record<string, unknown>> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, pick(item, keys, secretKeys)]),
  );
};

const authProviderKeys = [
  "enabled",
  "client_id",
  "secret",
  "url",
  "redirect_uri",
  "skip_nonce_check",
  "email_optional",
];
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
) => {
  const listener = listenerFromSection(document, "api", "port");
  const gatewayEnabled =
    config.api.enabled ||
    config.auth.enabled ||
    config.realtime.enabled ||
    config.storage.enabled ||
    config.edge_runtime.enabled ||
    config.analytics.enabled;
  if (listener === undefined) return listener;
  if (gatewayEnabled) {
    const port = explicitPort(document, "api", "port");
    return port === undefined ? {} : { port };
  }
  return { ...listener, enabled: false };
};

const listenerFromSection = (
  document: Readonly<Record<string, unknown>> | undefined,
  sectionName: string,
  portKey: string,
) => {
  const raw = section(document, sectionName);
  if (raw === undefined) return undefined;
  const enabled = raw["enabled"];
  const port = explicitPort(document, sectionName, portKey);
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
) => {
  const parent = section(document, sectionName);
  const nested = section(parent, nestedSection);
  if (nested === undefined) return undefined;
  const port = nestedPort(document, sectionName, nestedSection, portKey);
  if (nested.enabled === false) return { enabled: false };
  return port === undefined ? undefined : { port };
};

const authSettings = (auth: CliConfig["auth"]) => ({
  ...(auth.site_url === undefined ? {} : { site_url: auth.site_url }),
  ...(auth.additional_redirect_urls === undefined
    ? {}
    : { additional_redirect_urls: auth.additional_redirect_urls }),
  ...(auth.jwt_expiry === undefined ? {} : { jwt_expiry: auth.jwt_expiry }),
  ...(auth.jwt_issuer === undefined ? {} : { jwt_issuer: auth.jwt_issuer }),
  ...(auth.signing_keys_path === undefined ? {} : { signing_keys_path: auth.signing_keys_path }),
  ...(auth.enable_refresh_token_rotation === undefined
    ? {}
    : { enable_refresh_token_rotation: auth.enable_refresh_token_rotation }),
  ...(auth.refresh_token_reuse_interval === undefined
    ? {}
    : { refresh_token_reuse_interval: auth.refresh_token_reuse_interval }),
  ...(auth.enable_manual_linking === undefined
    ? {}
    : { enable_manual_linking: auth.enable_manual_linking }),
  ...(auth.enable_signup === undefined ? {} : { enable_signup: auth.enable_signup }),
  ...(auth.enable_anonymous_sign_ins === undefined
    ? {}
    : { enable_anonymous_sign_ins: auth.enable_anonymous_sign_ins }),
  ...(auth.minimum_password_length === undefined
    ? {}
    : { minimum_password_length: auth.minimum_password_length }),
  ...(auth.password_requirements === undefined
    ? {}
    : { password_requirements: auth.password_requirements }),
  ...(secret(auth.publishable_key) === undefined
    ? {}
    : { publishable_key: secret(auth.publishable_key) }),
  ...(secret(auth.secret_key) === undefined ? {} : { secret_key: secret(auth.secret_key) }),
  ...(secret(auth.jwt_secret) === undefined ? {} : { jwt_secret: secret(auth.jwt_secret) }),
  ...(secret(auth.anon_key) === undefined ? {} : { anon_key: secret(auth.anon_key) }),
  ...(secret(auth.service_role_key) === undefined
    ? {}
    : { service_role_key: secret(auth.service_role_key) }),
  ...(auth.rate_limit === undefined
    ? {}
    : {
        rate_limit: pick(auth.rate_limit, [
          "email_sent",
          "sms_sent",
          "anonymous_users",
          "token_refresh",
          "sign_in_sign_ups",
          "token_verifications",
          "web3",
        ]),
      }),
  ...(auth.captcha === undefined
    ? {}
    : { captcha: pick(auth.captcha, ["enabled", "provider", "secret"], new Set(["secret"])) }),
  ...(auth.hook === undefined
    ? {}
    : {
        hook: pickRecord(auth.hook, ["enabled", "uri", "secrets"], new Set(["secrets"])),
      }),
  ...(auth.mfa === undefined
    ? {}
    : {
        mfa: {
          ...pick(auth.mfa, ["max_enrolled_factors"]),
          ...(auth.mfa.totp === undefined
            ? {}
            : { totp: pick(auth.mfa.totp, ["enroll_enabled", "verify_enabled"]) }),
          ...(auth.mfa.phone === undefined
            ? {}
            : {
                phone: pick(auth.mfa.phone, [
                  "enroll_enabled",
                  "verify_enabled",
                  "otp_length",
                  "template",
                  "max_frequency",
                ]),
              }),
          ...(auth.mfa.web_authn === undefined
            ? {}
            : { web_authn: pick(auth.mfa.web_authn, ["enroll_enabled", "verify_enabled"]) }),
        },
      }),
  ...(auth.sessions === undefined
    ? {}
    : { sessions: pick(auth.sessions, ["timebox", "inactivity_timeout"]) }),
  ...(auth.email === undefined
    ? {}
    : {
        email: {
          ...pick(auth.email, [
            "enable_signup",
            "double_confirm_changes",
            "enable_confirmations",
            "secure_password_change",
            "max_frequency",
            "otp_length",
            "otp_expiry",
          ]),
          ...(auth.email.smtp === undefined
            ? {}
            : {
                smtp: pick(
                  auth.email.smtp,
                  ["enabled", "host", "port", "user", "pass", "admin_email", "sender_name"],
                  new Set(["pass"]),
                ),
              }),
          ...(auth.email.template === undefined
            ? {}
            : { template: pickRecord(auth.email.template, ["subject", "content_path"]) }),
          ...(auth.email.notification === undefined
            ? {}
            : {
                notification: pickRecord(auth.email.notification, [
                  "enabled",
                  "subject",
                  "content_path",
                ]),
              }),
        },
      }),
  ...(auth.sms === undefined
    ? {}
    : {
        sms: {
          ...pick(auth.sms, ["enable_signup", "enable_confirmations", "template", "max_frequency"]),
          ...(auth.sms.twilio === undefined
            ? {}
            : {
                twilio: pick(
                  auth.sms.twilio,
                  ["enabled", "account_sid", "message_service_sid", "auth_token"],
                  new Set(["auth_token"]),
                ),
              }),
          ...(auth.sms.twilio_verify === undefined
            ? {}
            : {
                twilio_verify: pick(
                  auth.sms.twilio_verify,
                  ["enabled", "account_sid", "message_service_sid", "auth_token"],
                  new Set(["auth_token"]),
                ),
              }),
          ...(auth.sms.messagebird === undefined
            ? {}
            : {
                messagebird: pick(
                  auth.sms.messagebird,
                  ["enabled", "originator", "access_key"],
                  new Set(["access_key"]),
                ),
              }),
          ...(auth.sms.textlocal === undefined
            ? {}
            : {
                textlocal: pick(
                  auth.sms.textlocal,
                  ["enabled", "sender", "api_key"],
                  new Set(["api_key"]),
                ),
              }),
          ...(auth.sms.vonage === undefined
            ? {}
            : {
                vonage: pick(
                  auth.sms.vonage,
                  ["enabled", "from", "api_key", "api_secret"],
                  new Set(["api_key", "api_secret"]),
                ),
              }),
          ...(auth.sms.test_otp === undefined ? {} : { test_otp: auth.sms.test_otp }),
        },
      }),
  ...(auth.external === undefined
    ? {}
    : {
        external: Object.fromEntries(
          authProviderNames
            .filter((name) => isRecord(auth.external) && auth.external[name] !== undefined)
            .map((name) => [
              name,
              pick(auth.external[name], authProviderKeys, new Set(["secret"])),
            ]),
        ),
      }),
  ...(auth.web3 === undefined ? {} : { web3: pickRecord(auth.web3, ["enabled"]) }),
  ...(auth.oauth_server === undefined
    ? {}
    : {
        oauth_server: pick(auth.oauth_server, [
          "enabled",
          "authorization_url_path",
          "allow_dynamic_registration",
        ]),
      }),
  ...(auth.third_party === undefined
    ? {}
    : {
        third_party: {
          ...(auth.third_party.firebase === undefined
            ? {}
            : { firebase: pick(auth.third_party.firebase, ["enabled", "project_id"]) }),
          ...(auth.third_party.auth0 === undefined
            ? {}
            : { auth0: pick(auth.third_party.auth0, ["enabled", "tenant", "tenant_region"]) }),
          ...(auth.third_party.aws_cognito === undefined
            ? {}
            : {
                aws_cognito: pick(auth.third_party.aws_cognito, [
                  "enabled",
                  "user_pool_id",
                  "user_pool_region",
                ]),
              }),
          ...(auth.third_party.clerk === undefined
            ? {}
            : { clerk: pick(auth.third_party.clerk, ["enabled", "domain"]) }),
          ...(auth.third_party.workos === undefined
            ? {}
            : { workos: pick(auth.third_party.workos, ["enabled", "issuer_url"]) }),
        },
      }),
});

const functionsSettings = (
  projectRoot: string,
  path: Path.Path,
  config: CliConfig,
  document?: Record<string, unknown>,
  projectEnvValues: Readonly<Record<string, string>> = {},
) => {
  const edge = config.edge_runtime;
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
      ...(edge.policy === undefined ? {} : { policy: edge.policy }),
      ...(edge.deno_version === undefined ? {} : { deno_version: edge.deno_version }),
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
  const capability = (enabled: boolean, settings: unknown) =>
    enabled ? { settings } : { enabled: false as const };
  return {
    capabilities: {
      database: {
        version: String(db.major_version),
        settings: { health_timeout: db.health_timeout, settings: db.settings },
      },
      rest: capability(api.enabled, {
        schemas: api.schemas,
        extra_search_path: api.extra_search_path,
        max_rows: api.max_rows,
        auto_expose_new_tables: api.auto_expose_new_tables,
        tls: api.tls,
        external_url: api.external_url,
      }),
      auth: capability(auth.enabled, authSettings(auth)),
      realtime: capability(realtime.enabled, {
        ip_version: realtime.ip_version,
        max_header_length: realtime.max_header_length,
      }),
      storage: capability(storage.enabled, {
        file_size_limit: storage.file_size_limit,
        image_transformation: storage.image_transformation,
        buckets: storage.buckets,
        s3_protocol: storage.s3_protocol,
        analytics: storage.analytics,
        vector: storage.vector,
      }),
      functions: capability(
        config.edge_runtime.enabled,
        functionsSettings(projectRoot, path, config, document, projectEnvValues),
      ),
      studio: capability(studio.enabled, {
        // A host-only default must remain unset so the stack runtime can append
        // the allocated API listener port. Explicit URLs remain caller-owned.
        api_url: studio.api_url === defaultStudioApiUrl ? undefined : studio.api_url,
        openai_api_key: secret(studio.openai_api_key),
      }),
      mail: capability(mail.enabled, {
        admin_email: mail.admin_email,
        sender_name: mail.sender_name,
      }),
      analytics: capability(analytics.enabled, {
        backend: analytics.backend,
        vector_port: analytics.vector_port,
        gcp_project_id: analytics.gcp_project_id,
        gcp_project_number: analytics.gcp_project_number,
        gcp_jwt_path: analytics.gcp_jwt_path,
      }),
      pooler: capability(pooler.enabled, {
        pool_mode: pooler.pool_mode,
        default_pool_size: pooler.default_pool_size,
        max_client_conn: pooler.max_client_conn,
      }),
    },
    listeners: {
      api: apiListener(document, config),
      database: listenerFromSection(document, "db", "port"),
      pooler: nestedListener(document, "db", "pooler", "port"),
      studio: listenerFromSection(document, "studio", "port"),
      mailUi: listenerFromSection(document, "local_smtp", "port"),
      smtp: listenerFromSection(document, "local_smtp", "smtp_port"),
      pop3: listenerFromSection(document, "local_smtp", "pop3_port"),
      functionsInspector: listenerFromSection(document, "edge_runtime", "inspector_port"),
    },
    security: {
      jwt: {
        ...(auth.jwt_issuer === undefined ? {} : { issuer: auth.jwt_issuer }),
        ...(auth.signing_keys_path !== undefined
          ? {
              signing: {
                kind: "jwks-file",
                path: stackProjectPath(path, auth.signing_keys_path),
              },
            }
          : secret(auth.jwt_secret) === undefined
            ? {}
            : { signing: { kind: "symmetric", secret: secret(auth.jwt_secret) } }),
      },
    },
  };
};

const findEncryptedSecret = (value: unknown, path = "config"): string | undefined => {
  if (Redacted.isRedacted(value)) {
    const secretValue = Redacted.value(value);
    return typeof secretValue === "string" && secretValue.startsWith("encrypted:")
      ? path
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findEncryptedSecret(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const found = findEncryptedSecret(item, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

const configValidationError = (
  path: Path.Path,
  projectRoot: string,
  config: CliConfig,
  projectEnvValues: Readonly<Record<string, string>>,
): string | undefined => {
  const figma = config.auth.external.figma;
  if (figma?.enabled === true)
    return "auth.external.figma is enabled but unsupported by the experimental stack";
  if (config.edge_runtime.enabled === false) return undefined;
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

/** Loads and translates the effective project config for all stack commands. */
export const loadStackConfig = (projectRoot: string): StackConfigEffect =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* loadLocalProjectContext(
      projectRoot,
      (message) => new StackConfigError({ message }),
    ).pipe(
      Effect.flatMap((context) =>
        context.loaded === null
          ? Effect.fail(
              new StackConfigError({
                message: `No Supabase project configuration found in ${projectRoot}. Run supabase init first.`,
              }),
            )
          : readFunctionEnvironments(
              projectRoot,
              new Set(
                Object.entries(context.config.functions)
                  .filter(([, functionConfig]) => functionConfig.enabled === false)
                  .map(([name]) => name),
              ),
              context.config.edge_runtime.enabled === false,
            ).pipe(
              Effect.mapError((cause) =>
                cause instanceof StackConfigError
                  ? cause
                  : new StackConfigError({ message: String(cause) }),
              ),
              Effect.flatMap(
                (
                  environments: Readonly<{
                    readonly shared: Readonly<Record<string, Redacted.Redacted<string>>>;
                    readonly functions: Readonly<
                      Record<string, Readonly<Record<string, Redacted.Redacted<string>>>>
                    >;
                  }>,
                ) => {
                  const validationError = configValidationError(
                    path,
                    projectRoot,
                    context.config,
                    context.projectEnvValues,
                  );
                  if (validationError !== undefined)
                    return Effect.fail(new StackConfigError({ message: validationError }));
                  const input = configInput(
                    projectRoot,
                    path,
                    context.config,
                    context.loaded?.document,
                    context.projectEnvValues,
                  );
                  if (input.capabilities.functions.enabled === false) return Effect.succeed(input);
                  const functionSettings = isRecord(input.capabilities.functions.settings)
                    ? input.capabilities.functions.settings
                    : {};
                  const functions = isRecord(functionSettings.functions)
                    ? functionSettings.functions
                    : {};
                  const allFunctions = {
                    ...Object.fromEntries(
                      Object.keys(environments.functions).map((name) => [
                        name,
                        { env: environments.functions[name] },
                      ]),
                    ),
                    ...functions,
                  };
                  return Effect.succeed({
                    ...input,
                    capabilities: {
                      ...input.capabilities,
                      functions: {
                        ...input.capabilities.functions,
                        settings: {
                          ...functionSettings,
                          edge_runtime: {
                            ...(isRecord(functionSettings.edge_runtime)
                              ? functionSettings.edge_runtime
                              : {}),
                            secrets: {
                              ...environments.shared,
                              ...(isRecord(functionSettings.edge_runtime) &&
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
                  });
                },
              ),
              Effect.flatMap((input) =>
                Effect.gen(function* () {
                  const encryptedPath = findEncryptedSecret(input);
                  if (encryptedPath !== undefined)
                    return yield* new StackConfigError({
                      message: `${encryptedPath} uses an encrypted secret, which the experimental stack does not support; decrypt it before starting the stack`,
                    });
                  return yield* Schema.decodeUnknownEffect(StackConfigSchema)(
                    withoutUndefined(input),
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
                }),
              ),
            ),
      ),
    );
  });

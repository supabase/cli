import { Redacted } from "effect";
import type { CliConfig } from "@supabase/config";
import type {
  AuthSettings,
  DatabaseSettings,
  FunctionsSettings,
  RestSettings,
  StackConfig,
  StackRuntimePreference,
} from "@supabase/stack/effect";

export const excludedStackServices = [
  "auth",
  "realtime",
  "storage",
  "studio",
  "analytics",
  "pooler",
] as const;
export type ExcludedStackService = (typeof excludedStackServices)[number];
export const isExcludedStackService = (value: string): value is ExcludedStackService =>
  excludedStackServices.some((candidate) => candidate === value);
export const startModes = ["native", "docker"] as const;
export type StartMode = (typeof startModes)[number];

const disabledCapability = (
  name: string,
  _native: boolean,
  excluded: ReadonlySet<ExcludedStackService>,
  enabled?: boolean,
) => (isExcludedStackService(name) && excluded.has(name)) || enabled === false;

const capability = <S>(
  name: string,
  native: boolean,
  excluded: ReadonlySet<ExcludedStackService>,
  enabled: boolean | undefined,
  settings: S,
) =>
  disabledCapability(name, native, excluded, enabled)
    ? ({ enabled: false } as const)
    : settings === undefined
      ? {}
      : { settings };

const secretValue = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const secretRecord = (value: Readonly<Record<string, string>> | undefined) =>
  value === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(value).map(([name, secret]) => [name, Redacted.make(secret)]),
      );

const passwordRequirements = (value: string | undefined): AuthSettings["password_requirements"] =>
  value === "" ||
  value === "letters_digits" ||
  value === "lower_upper_letters_digits" ||
  value === "lower_upper_letters_digits_symbols"
    ? value
    : undefined;

const sessionReplicationRole = (
  value: string | undefined,
): NonNullable<NonNullable<DatabaseSettings["settings"]>>["session_replication_role"] =>
  value === "origin" || value === "replica" || value === "local" ? value : undefined;

const edgePolicy = (value: string | undefined): "oneshot" | "per_worker" | undefined =>
  value === "oneshot" || value === "per_worker" ? value : undefined;

const ipVersion = (value: string | undefined): "IPv4" | "IPv6" | undefined =>
  value === "IPv4" || value === "IPv6" ? value : undefined;

const captchaProvider = (value: string | undefined): "hcaptcha" | "turnstile" | undefined =>
  value === "hcaptcha" || value === "turnstile" ? value : undefined;

const analyticsBackend = (value: string | undefined): "postgres" | "bigquery" | undefined =>
  value === "postgres" || value === "bigquery" ? value : undefined;

const poolMode = (value: string | undefined): "transaction" | "session" | undefined =>
  value === "transaction" || value === "session" ? value : undefined;

const toDatabaseSettings = (db: CliConfig["db"] | undefined): DatabaseSettings => ({
  health_timeout: db?.health_timeout,
  settings:
    db?.settings === undefined
      ? undefined
      : {
          ...db.settings,
          session_replication_role: sessionReplicationRole(db.settings.session_replication_role),
        },
  network_restrictions: db?.network_restrictions,
  ssl_enforcement: db?.ssl_enforcement,
  vault: secretRecord(db?.vault),
});

const toRestSettings = (api: CliConfig["api"] | undefined): RestSettings => ({
  schemas: api?.schemas,
  extra_search_path: api?.extra_search_path,
  max_rows: api?.max_rows,
  auto_expose_new_tables: api?.auto_expose_new_tables,
  tls: api?.tls,
  external_url: api?.external_url,
});

const toFunctionsSettings = (
  edgeRuntime: CliConfig["edge_runtime"] | undefined,
  functions: CliConfig["functions"] | undefined,
): FunctionsSettings => ({
  functions_root: "supabase/functions",
  edge_runtime:
    edgeRuntime === undefined
      ? undefined
      : {
          policy: edgePolicy(edgeRuntime.policy),
          deno_version: edgeRuntime.deno_version,
          secrets: secretRecord(edgeRuntime.secrets),
        },
  functions:
    functions === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(functions).map(([name, fn]) => [
            name,
            {
              ...fn,
              env: secretRecord(fn.env),
            },
          ]),
        ),
});

const toAuthSettings = (auth: CliConfig["auth"] | undefined): AuthSettings | undefined => {
  if (auth === undefined) return undefined;
  const {
    enabled: _enabled,
    password_requirements: requirements,
    publishable_key,
    secret_key,
    jwt_secret,
    anon_key,
    service_role_key,
    ...rest
  } = auth;
  return {
    ...rest,
    password_requirements: passwordRequirements(requirements),
    publishable_key: secretValue(publishable_key),
    secret_key: secretValue(secret_key),
    jwt_secret: secretValue(jwt_secret),
    anon_key: secretValue(anon_key),
    service_role_key: secretValue(service_role_key),
    email:
      rest.email === undefined
        ? undefined
        : {
            ...rest.email,
            smtp:
              rest.email.smtp === undefined
                ? undefined
                : { ...rest.email.smtp, pass: secretValue(rest.email.smtp.pass) },
          },
    sms:
      rest.sms === undefined
        ? undefined
        : {
            ...rest.sms,
            twilio:
              rest.sms.twilio === undefined
                ? undefined
                : { ...rest.sms.twilio, auth_token: secretValue(rest.sms.twilio.auth_token) },
            twilio_verify:
              rest.sms.twilio_verify === undefined
                ? undefined
                : {
                    ...rest.sms.twilio_verify,
                    auth_token: secretValue(rest.sms.twilio_verify.auth_token),
                  },
            messagebird:
              rest.sms.messagebird === undefined
                ? undefined
                : {
                    ...rest.sms.messagebird,
                    access_key: secretValue(rest.sms.messagebird.access_key),
                  },
            textlocal:
              rest.sms.textlocal === undefined
                ? undefined
                : { ...rest.sms.textlocal, api_key: secretValue(rest.sms.textlocal.api_key) },
            vonage:
              rest.sms.vonage === undefined
                ? undefined
                : {
                    ...rest.sms.vonage,
                    api_key: secretValue(rest.sms.vonage.api_key),
                    api_secret: secretValue(rest.sms.vonage.api_secret),
                  },
          },
    captcha:
      rest.captcha === undefined
        ? undefined
        : {
            ...rest.captcha,
            provider: captchaProvider(rest.captcha.provider),
            secret: secretValue(rest.captcha.secret),
          },
    hook:
      rest.hook === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(rest.hook).map(([name, hook]) => [
              name,
              hook === undefined ? undefined : { ...hook, secrets: secretValue(hook.secrets) },
            ]),
          ),
    external:
      rest.external === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(rest.external).map(([name, provider]) => [
              name,
              provider === undefined
                ? undefined
                : { ...provider, secret: secretValue(provider.secret) },
            ]),
          ),
  };
};

/** Translates CLI exclusions and mode to the stack's closed capability config. */
export function toStartStackConfig(
  config: CliConfig | undefined,
  exclude: ReadonlyArray<ExcludedStackService>,
  mode?: StartMode,
): StackConfig {
  const excluded = new Set(exclude);
  const native = mode === "native";
  const db = config?.db;
  const api = config?.api;
  const auth = config?.auth;
  const realtime = config?.realtime;
  const storage = config?.storage;
  const edgeRuntime = config?.edge_runtime;
  const functions = config?.functions;
  const studio = config?.studio;
  const mail = config?.local_smtp;
  const analytics = config?.analytics;
  const pooler = db?.pooler;
  const databaseSettings = toDatabaseSettings(db);
  const functionSettings = toFunctionsSettings(edgeRuntime, functions);
  const authSettings = toAuthSettings(auth);
  const studioSettings =
    studio === undefined
      ? undefined
      : {
          api_url: studio.api_url,
          openai_api_key: secretValue(studio.openai_api_key),
        };
  const analyticsSettings =
    analytics === undefined
      ? undefined
      : {
          backend: analyticsBackend(analytics.backend),
          vector_port: analytics.vector_port,
          gcp_project_id: analytics.gcp_project_id,
          gcp_project_number: analytics.gcp_project_number,
          gcp_jwt_path: analytics.gcp_jwt_path,
        };
  const poolerSettings =
    pooler === undefined
      ? undefined
      : {
          pool_mode: poolMode(pooler.pool_mode),
          default_pool_size: pooler.default_pool_size,
          max_client_conn: pooler.max_client_conn,
        };
  return {
    capabilities: {
      database: { version: db?.major_version?.toString(), settings: databaseSettings },
      rest: capability("rest", native, excluded, api?.enabled, toRestSettings(api)),
      auth: capability("auth", native, excluded, auth?.enabled, authSettings),
      realtime: capability("realtime", native, excluded, realtime?.enabled, {
        ip_version: ipVersion(realtime?.ip_version),
        max_header_length: realtime?.max_header_length,
      }),
      storage: capability("storage", native, excluded, storage?.enabled, {
        file_size_limit: storage?.file_size_limit,
        image_transformation: storage?.image_transformation,
        buckets: storage?.buckets,
        s3_protocol: storage?.s3_protocol,
        analytics: storage?.analytics,
        vector: storage?.vector,
      }),
      functions: capability("functions", native, excluded, edgeRuntime?.enabled, functionSettings),
      studio: capability("studio", native, excluded, studio?.enabled, studioSettings),
      mail: capability("mail", native, excluded, mail?.enabled, {
        admin_email: mail?.admin_email,
        sender_name: mail?.sender_name,
      }),
      analytics: capability("analytics", native, excluded, analytics?.enabled, analyticsSettings),
      pooler: capability("pooler", native, excluded, pooler?.enabled, poolerSettings),
    },
    listeners: {
      api: api === undefined ? undefined : { port: api.port },
      database: db === undefined ? undefined : { port: db.port },
      pooler: pooler === undefined ? undefined : { port: pooler.port },
      studio: studio === undefined ? undefined : { port: studio.port },
      mailUi: mail === undefined ? undefined : { port: mail.port },
      smtp: mail?.smtp_port === undefined ? undefined : { port: mail.smtp_port },
      pop3: mail?.pop3_port === undefined ? undefined : { port: mail.pop3_port },
      functionsInspector:
        edgeRuntime === undefined ? undefined : { port: edgeRuntime.inspector_port },
    },
    security:
      auth?.jwt_secret === undefined &&
      auth?.jwt_issuer === undefined &&
      auth?.signing_keys_path === undefined
        ? undefined
        : {
            jwt: {
              issuer: auth.jwt_issuer,
              signing:
                auth.jwt_secret === undefined
                  ? auth.signing_keys_path === undefined
                    ? undefined
                    : { kind: "jwks-file", path: auth.signing_keys_path }
                  : { kind: "symmetric", secret: Redacted.make(auth.jwt_secret) },
            },
          },
  };
}

export function runtimePreference(mode?: StartMode): StackRuntimePreference | undefined {
  return mode === undefined
    ? undefined
    : mode === "native"
      ? { kind: "native" }
      : { kind: "container" };
}

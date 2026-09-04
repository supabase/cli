import { Effect, Redacted, Schema } from "effect";
import { Flag } from "effect/unstable/cli";
import { isAbsolute, relative, resolve } from "node:path";
import type { CliConfig } from "@supabase/config";
import {
  StackConfigSchema,
  type AuthSettings,
  type DatabaseSettings,
  type FunctionsSettings,
  type RestSettings,
  type StackConfig,
  type StackRuntimePreference,
  InvalidStackConfigError,
} from "@supabase/stack/effect";

const excludedStackServices = [
  "auth",
  "realtime",
  "storage",
  "studio",
  "analytics",
  "pooler",
] as const;
export type ExcludedStackService = (typeof excludedStackServices)[number];
export const excludeFlag = Flag.choice("exclude", excludedStackServices).pipe(
  Flag.atMost(excludedStackServices.length),
  Flag.withDefault([] as ReadonlyArray<ExcludedStackService>),
);
const isExcludedStackService = (value: string): value is ExcludedStackService =>
  excludedStackServices.some((candidate) => candidate === value);
const startModes = ["native", "docker"] as const;
export type StartMode = (typeof startModes)[number];

const disabledCapability = (
  name: string,
  excluded: ReadonlySet<ExcludedStackService>,
  enabled?: boolean,
) => (isExcludedStackService(name) && excluded.has(name)) || enabled === false;

const capability = <S>(
  name: string,
  excluded: ReadonlySet<ExcludedStackService>,
  enabled: boolean | undefined,
  settings: S,
) =>
  disabledCapability(name, excluded, enabled)
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

/** Omit absent object properties while preserving arrays and redacted values. */
const omitUndefined = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Redacted.isRedacted(value)) return value;
  if (Array.isArray(value)) return value.map(omitUndefined);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, omitUndefined(child)]),
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A decoded config paired with its raw document so key presence survives schema defaults. */
export interface CliConfigWithRawPresence {
  readonly config: CliConfig;
  readonly document?: Readonly<Record<string, unknown>>;
}

const hasOwnPath = (
  root: Readonly<Record<string, unknown>> | undefined,
  path: ReadonlyArray<string>,
): boolean => {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
};

const unwrapConfig = (
  input: CliConfig | CliConfigWithRawPresence | undefined,
): {
  readonly config: CliConfig | undefined;
  readonly document: Readonly<Record<string, unknown>> | undefined;
} => {
  if (input === undefined) return { config: undefined, document: undefined };
  if ("config" in input) return { config: input.config, document: input.document };
  return { config: input, document: undefined };
};

const configuredListener = (
  section: unknown,
  port: number | undefined,
  path: ReadonlyArray<string>,
  document: Readonly<Record<string, unknown>> | undefined,
) => {
  if (section === undefined) return undefined;
  if (document !== undefined && !hasOwnPath(document, path)) return undefined;
  return port === undefined ? {} : { port };
};

const dedicatedListener = (
  disabled: boolean,
  section: unknown,
  port: number | undefined,
  path: ReadonlyArray<string>,
  document: Readonly<Record<string, unknown>> | undefined,
) => (disabled ? ({ enabled: false } as const) : configuredListener(section, port, path, document));

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

/**
 * Converts a config path (relative to `supabase`) to the path expected by the
 * stack's Functions runtime (relative to that function's directory).
 *
 * CLI config and Functions manifests use paths such as
 * `./functions/hello/index.ts`, while the stack resolves `hello/index.ts`
 * against `functions_root`. Both `start` and `functions serve` reuse this
 * translation.
 */
const normalizeFunctionsPath = (pathname: string): string =>
  pathname
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^supabase\//, "");

export function relativeFunctionPath(slug: string, pathname: string): string;
export function relativeFunctionPath(slug: string, pathname: undefined): undefined;
export function relativeFunctionPath(
  slug: string,
  pathname: string | undefined,
): string | undefined {
  if (pathname === undefined) return undefined;
  const normalized = normalizeFunctionsPath(pathname);
  const prefix = `functions/${slug}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : pathname;
}

/** Whether a path is explicitly rooted at one function's directory. */
export function isFunctionScopedPath(slug: string, pathname: string | undefined): boolean {
  if (pathname === undefined) return false;
  const normalized = normalizeFunctionsPath(pathname);
  return normalized.startsWith(`functions/${slug}/`);
}

/**
 * Converts a Functions path supplied for one project function into a path
 * relative to the shared `functions_root`. This is used by serve's global
 * `--import-map` default; `./functions/hello/deno.json` becomes
 * `hello/deno.json`, so every discovered slug resolves the same file. Absolute
 * or caller-cwd paths are also converted when `projectRoot` is supplied.
 */
export function relativeGlobalFunctionPath(
  pathname: string | undefined,
  options: { readonly projectRoot?: string; readonly cwd?: string } = {},
): string | undefined {
  if (pathname === undefined) return undefined;
  const normalized = normalizeFunctionsPath(pathname);
  if (normalized.startsWith("functions/")) return normalized.slice("functions/".length);

  // CLI flags are normally relative to the caller's cwd. Persist only a path
  // relative to `functions_root` so the same config works in native and
  // container runtimes. Out-of-root values remain unchanged and are rejected
  // by the runtime's canonical containment check.
  if (options.projectRoot !== undefined) {
    const functionsRoot = resolve(options.projectRoot, "supabase", "functions");
    const absolute = isAbsolute(pathname)
      ? pathname
      : resolve(options.cwd ?? options.projectRoot, pathname);
    const rootRelative = relative(functionsRoot, absolute).replaceAll("\\", "/");
    if (
      rootRelative !== "" &&
      rootRelative !== ".." &&
      !rootRelative.startsWith("../") &&
      !isAbsolute(rootRelative)
    )
      return rootRelative;
  }
  return normalized;
}

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
              import_map: relativeFunctionPath(name, fn.import_map),
              entrypoint: relativeFunctionPath(name, fn.entrypoint),
              static_files: fn.static_files?.map((pathname) =>
                relativeFunctionPath(name, pathname),
              ),
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

/** Translates CLI exclusions to the stack's closed capability config. */
export function toStartStackConfig(
  input: CliConfig | CliConfigWithRawPresence | undefined,
  exclude: ReadonlyArray<ExcludedStackService>,
): Effect.Effect<StackConfig, InvalidStackConfigError> {
  const { config, document } = unwrapConfig(input);
  const excluded = new Set(exclude);
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
  const configOutput = {
    capabilities: {
      database: { version: db?.major_version?.toString(), settings: databaseSettings },
      rest: capability("rest", excluded, api?.enabled, toRestSettings(api)),
      auth: capability("auth", excluded, auth?.enabled, authSettings),
      realtime: capability("realtime", excluded, realtime?.enabled, {
        ip_version: ipVersion(realtime?.ip_version),
        max_header_length: realtime?.max_header_length,
      }),
      storage: capability("storage", excluded, storage?.enabled, {
        file_size_limit: storage?.file_size_limit,
        image_transformation: storage?.image_transformation,
        buckets: storage?.buckets,
        s3_protocol: storage?.s3_protocol,
        analytics: storage?.analytics,
        vector: storage?.vector,
      }),
      functions: capability("functions", excluded, edgeRuntime?.enabled, functionSettings),
      studio: capability("studio", excluded, studio?.enabled, studioSettings),
      mail: capability("mail", excluded, mail?.enabled, {
        admin_email: mail?.admin_email,
        sender_name: mail?.sender_name,
      }),
      analytics: capability("analytics", excluded, analytics?.enabled, analyticsSettings),
      pooler: capability("pooler", excluded, pooler?.enabled, poolerSettings),
    },
    listeners: {
      api: configuredListener(api, api?.port, ["api", "port"], document),
      database: configuredListener(db, db?.port, ["db", "port"], document),
      pooler: dedicatedListener(
        disabledCapability("pooler", excluded, pooler?.enabled),
        pooler,
        pooler?.port,
        ["db", "pooler", "port"],
        document,
      ),
      studio: dedicatedListener(
        disabledCapability("studio", excluded, studio?.enabled),
        studio,
        studio?.port,
        ["studio", "port"],
        document,
      ),
      mailUi: dedicatedListener(
        disabledCapability("mail", excluded, mail?.enabled),
        mail,
        mail?.port,
        ["local_smtp", "port"],
        document,
      ),
      smtp: dedicatedListener(
        disabledCapability("mail", excluded, mail?.enabled),
        mail,
        mail?.smtp_port,
        ["local_smtp", "smtp_port"],
        document,
      ),
      pop3: dedicatedListener(
        disabledCapability("mail", excluded, mail?.enabled),
        mail,
        mail?.pop3_port,
        ["local_smtp", "pop3_port"],
        document,
      ),
      functionsInspector: dedicatedListener(
        disabledCapability("functions", excluded, edgeRuntime?.enabled),
        edgeRuntime,
        edgeRuntime?.inspector_port,
        ["edge_runtime", "inspector_port"],
        document,
      ),
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

  // Keep schema failures in the Effect error channel so command boundaries can render a tagged
  // InvalidStackConfigError rather than throwing synchronously inside an Effect generator.
  return Schema.decodeUnknownEffect(StackConfigSchema)(omitUndefined(configOutput), {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (error) =>
        new InvalidStackConfigError({
          message: `Invalid stack configuration: ${String(error)}`,
        }),
    ),
  );
}

export function runtimePreference(mode?: StartMode): StackRuntimePreference | undefined {
  return mode === undefined
    ? undefined
    : mode === "native"
      ? { kind: "native" }
      : { kind: "container" };
}

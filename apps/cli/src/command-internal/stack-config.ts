import { getDefaultCliConfig, type CliConfig } from "@supabase/config";
import {
  DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  DEFAULT_LOCAL_S3_REGION,
  DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
  DEFAULT_SIGNING_KEY,
} from "@supabase/stack/defaults";
import { type ServiceCreationInput as ServiceCreationType } from "@supabase/stack/effect";
import { Crypto, Effect, Data, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { CliConfigKeys, type AnyCliConfigKey } from "../config/cli-config-keys.ts";
import { resolveSnapshotSubtree } from "../config/cli-config-subtree.ts";
import type {
  CliConfigMaterialized,
  CliConfigValues,
} from "../config/cli-config-values.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { CLI_VERSION } from "../shared/cli/version.ts";
import {
  describeConfigSnapshotFailure,
  loadConfigSnapshotContext,
  resolveSnapshotPasskeyWebauthn,
} from "./config-snapshot-context.ts";
import { resolveAuthConfig } from "./stack-auth-config.ts";
import { resolveSmtpEnabled } from "./smtp-enabled.ts";
import { parseDuration } from "./duration.ts";
import { parseFileSizeLimit } from "./storage-bucket-config.ts";

import {
  resolveJwtSecret,
  resolveConfiguredSigningKeys,
  resolveAuthExternalProviders,
} from "./local-config-values.ts";
import { generateAsymmetricLocalJwt } from "./local-jwt.ts";
import { recordOrioleDbTelemetry } from "./db-image.ts";
import {
  resolveRemoteJwks,
  resolveThirdPartyIssuerUrl,
  thirdPartyIssuerUrlUnchecked,
  toPublicJwk,
} from "../shared/auth/jwks.ts";
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
  readonly creations: (
    stackId: string,
  ) => Effect.Effect<ReadonlyArray<ServiceCreationType>, StackConfigError>;
  readonly source: CliConfig;
  readonly projectEnvValues: Readonly<Record<string, string>>;
  readonly originAt: CliConfigMaterialized["originAt"];
  readonly remoteJwks: Effect.Effect<string | undefined, StackConfigError>;
  readonly keys: Effect.Effect<
    {
      readonly publishableKey?: string;
      readonly secretKey?: string;
      readonly anonKey?: string;
      readonly serviceRoleKey?: string;
      readonly anonKeyIsOverride: boolean;
      readonly serviceRoleKeyIsOverride: boolean;
      readonly gotrueJwtKeys?: string;
      readonly publicSigningKeys?: string;
      readonly remoteJwks?: string;
    },
    StackConfigError
  >;
}

type StackConfigEffect = Effect.Effect<
  StackStartConfig,
  StackConfigError,
  FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto | CliConfigValues
>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encodeJwkArray = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

const section = (document: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = document?.[name];
  return isRecord(value) ? value : undefined;
};

/** The config key behind a saved stack endpoint; its `path` and `env[0]` name the setting. */
export type StackEndpointKey = Pick<AnyCliConfigKey, "path" | "env">;

/**
 * Maps a saved stack endpoint (service + endpoint name) to the config key that controls it.
 * An endpoint missing here (e.g. `pooler.http`, `realtime.rpc`) is always automatic.
 */
const endpointKeysByServiceEndpoint: Readonly<Record<string, StackEndpointKey>> = {
  "database.sql": CliConfigKeys.db.port,
  "pooler.sql": CliConfigKeys.db.pooler.port,
  "analytics.http": CliConfigKeys.analytics.port,
  "studio.http": CliConfigKeys.studio.port,
  "mail.http": CliConfigKeys.localSmtp.port,
  "mail.smtp": CliConfigKeys.localSmtp.smtpPort,
  "mail.pop3": CliConfigKeys.localSmtp.pop3Port,
  "functions.inspector": CliConfigKeys.edgeRuntime.inspectorPort,
  "rest.http": CliConfigKeys.api.port,
  "auth.http": CliConfigKeys.api.port,
  "realtime.http": CliConfigKeys.api.port,
  "storage.http": CliConfigKeys.api.port,
  "functions.http": CliConfigKeys.api.port,
};

/** The config key that sets a service endpoint's port, when the CLI exposes one. */
export const stackEndpointKey = (service: string, endpoint: string): StackEndpointKey | undefined =>
  endpointKeysByServiceEndpoint[`${service}.${endpoint}`];

export const stackMajorVersionKey: StackEndpointKey = CliConfigKeys.db.majorVersion;

const unsupportedConfigPaths = [
  { path: "api.tls", active: (config: CliConfig) => config.api.enabled },
  { path: "analytics.gcp_project_id", active: (config: CliConfig) => config.analytics.enabled },
  {
    path: "analytics.gcp_project_number",
    active: (config: CliConfig) => config.analytics.enabled,
  },
  { path: "analytics.gcp_jwt_path", active: (config: CliConfig) => config.analytics.enabled },
  { path: "edge_runtime.deno_version", active: (config: CliConfig) => config.edge_runtime.enabled },
  { path: "storage.analytics", active: (config: CliConfig) => config.storage.enabled },
  { path: "db.orioledb_version", active: (_config: CliConfig) => true },
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

const configValidationError = (config: CliConfig): string | undefined => {
  const defaults = getDefaultCliConfig();
  if (config.auth.enabled) {
    for (const [name, template] of Object.entries(config.auth.email.template))
      if (template.content_path !== "")
        return `auth.email.template.${name}.content_path requires template serving, which is not supported by the experimental stack`;
    for (const [name, notification] of Object.entries(config.auth.email.notification))
      if (notification.enabled && notification.content_path !== "")
        return `auth.email.notification.${name}.content_path requires template serving, which is not supported by the experimental stack`;
  }
  for (const { path, active } of unsupportedConfigPaths) {
    if (!active(config)) continue;
    const value = pathValue(config, path);
    const baseline = pathValue(defaults, path);
    const difference = firstDifference(value, baseline, path);
    if (difference !== undefined) return `${difference} is unsupported by the experimental stack`;
  }
  if (config.analytics.enabled && config.analytics.backend !== "postgres")
    return "analytics.backend must be postgres for the experimental stack";
  if (
    config.storage.enabled &&
    config.storage.vector.enabled &&
    Object.keys(config.storage.vector.buckets).length > 0
  )
    return "storage.vector settings are unsupported by the experimental stack";
  if (config.db.major_version !== 15 && config.db.major_version !== 17)
    return "db.major_version must be 15 or 17 for the experimental stack";

  return undefined;
};

const toStackConfigError = (cause: { readonly message: string }) =>
  new StackConfigError({ message: cause.message });

const endpoint = (port: number | undefined): { readonly port: number | "auto" } => ({
  port: port === undefined ? "auto" : port,
});

/** Loads and translates the effective project config for all stack commands. */
export const loadStackConfig = Effect.fn("StackConfig.load")(
  (projectRoot: string, opts?: { readonly projectRef?: string }): StackConfigEffect =>
    Effect.gen(function* () {
      const {
        snapshot,
        config: validatedConfig,
        projectEnvValues,
        document,
      } = yield* loadConfigSnapshotContext(
        projectRoot,
        Option.fromNullishOr(opts?.projectRef),
      ).pipe(
        Effect.mapError(
          (cause) => new StackConfigError({ message: describeConfigSnapshotFailure(cause) }),
        ),
      );
      const { originAt } = snapshot.materialized;
      yield* recordOrioleDbTelemetry(
        validatedConfig.db.orioledb_version,
        validatedConfig.db.major_version,
      );
      const validationError = configValidationError(validatedConfig);
      if (validationError !== undefined)
        return yield* new StackConfigError({ message: validationError });

      const externalProviders = yield* Effect.try({
        try: () =>
          resolveAuthExternalProviders(section(document, "auth"), validatedConfig.auth.external),
        catch: (cause) =>
          new StackConfigError({
            message: cause instanceof Error ? cause.message : "invalid auth provider config",
          }),
      });
      const authExternalUrl = Option.getOrUndefined(
        (yield* snapshot
          .get(CliConfigKeys.auth.externalUrl)
          .pipe(Effect.mapError(toStackConfigError))).value,
      );
      const authConfig = yield* resolveAuthConfig(
        validatedConfig.auth,
        validatedConfig.local_smtp,
        {
          smtpEnabled: resolveSmtpEnabled(snapshot),
          authExternalUrl,
          apiExternalUrl: validatedConfig.api.external_url,
          externalProviders,
          ...(yield* resolveSnapshotPasskeyWebauthn(snapshot).pipe(
            Effect.mapError(toStackConfigError),
          )),
        },
      );
      const path = yield* Path.Path;
      const auth = validatedConfig.auth;
      const issuer = yield* Effect.try({
        try: () => {
          const resolved = auth.enabled
            ? resolveThirdPartyIssuerUrl(auth.third_party)
            : thirdPartyIssuerUrlUnchecked(auth.third_party);
          return resolved === undefined || resolved.length === 0 ? undefined : resolved;
        },
        catch: (cause) =>
          new StackConfigError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const localKeys = Effect.try({
        try: () => {
          const configured = (value: string | undefined) =>
            value === undefined || value === "" ? undefined : value;
          const publishableKey = configured(auth.publishable_key);
          const secretKey = configured(auth.secret_key);
          const configuredAnonKey = configured(auth.anon_key);
          const configuredServiceRoleKey = configured(auth.service_role_key);
          const configuredSigningKeys = resolveConfiguredSigningKeys(validatedConfig, projectRoot);
          const signingKeys =
            configuredSigningKeys ??
            (auth.signing_keys_path === undefined || auth.signing_keys_path.length === 0
              ? undefined
              : [DEFAULT_SIGNING_KEY]);
          const signingKey = signingKeys?.[0];
          return {
            ...(publishableKey === undefined ? {} : { publishableKey }),
            ...(secretKey === undefined ? {} : { secretKey }),
            ...(configuredAnonKey === undefined
              ? signingKey === undefined
                ? {}
                : { anonKey: generateAsymmetricLocalJwt(signingKey, "anon") }
              : { anonKey: configuredAnonKey }),
            ...(configuredServiceRoleKey === undefined
              ? signingKey === undefined
                ? {}
                : { serviceRoleKey: generateAsymmetricLocalJwt(signingKey, "service_role") }
              : { serviceRoleKey: configuredServiceRoleKey }),
            anonKeyIsOverride: configuredAnonKey !== undefined,
            serviceRoleKeyIsOverride: configuredServiceRoleKey !== undefined,
            ...(signingKeys === undefined
              ? {}
              : {
                  gotrueJwtKeys: encodeJwkArray(signingKeys),
                  publicSigningKeys: encodeJwkArray(signingKeys.map(toPublicJwk)),
                }),
          };
        },
        catch: (cause) =>
          new StackConfigError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const remoteJwks = Effect.gen(function* () {
        return issuer === undefined
          ? undefined
          : encodeJwkArray(
              yield* resolveRemoteJwks(issuer).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.mapError((cause) => new StackConfigError({ message: cause.message })),
                Effect.withSpan("StackConfig.fetchRemoteJwks"),
              ),
            );
      });
      const keys = Effect.gen(function* () {
        const configuredKeys = yield* localKeys;
        const refreshedRemoteJwks = yield* remoteJwks;
        return {
          ...configuredKeys,
          ...(refreshedRemoteJwks === undefined ? {} : { remoteJwks: refreshedRemoteJwks }),
        };
      });
      const functionEnvironments = Object.fromEntries(
        yield* Effect.forEach(Object.entries(validatedConfig.functions), ([name, config]) =>
          resolveSnapshotSubtree(snapshot, config.env, `functions.${name}.env`).pipe(
            Effect.mapError((error) => new StackConfigError({ message: error.message })),
            Effect.map(
              (env) =>
                [
                  name,
                  Object.fromEntries(
                    Object.entries(env).map(([key, value]) => [
                      key,
                      Redacted.isRedacted(value) ? Redacted.value(value) : value,
                    ]),
                  ),
                ] as const,
            ),
          ),
        ),
      );
      const functions = yield* Effect.try({
        try: () =>
          Object.fromEntries(
            Object.entries(validatedConfig.functions).map(([name, config]) => {
              const resolveFile = (value: string) => {
                const resolved = path.resolve(projectRoot, "supabase", value);
                const relative = path.relative(projectRoot, resolved);
                if (
                  relative === ".." ||
                  relative.startsWith(`..${path.sep}`) ||
                  path.isAbsolute(relative)
                )
                  throw new Error(
                    `functions.${name} paths must remain within the project directory`,
                  );
                return resolved;
              };
              return [
                name,
                {
                  enabled: config.enabled,
                  verifyJWT: config.verify_jwt,
                  ...(config.entrypoint === ""
                    ? {}
                    : { entrypoint: resolveFile(config.entrypoint) }),
                  ...(config.import_map === ""
                    ? {}
                    : { import_map: resolveFile(config.import_map) }),
                  static_files: config.static_files.map(resolveFile),
                  env: functionEnvironments[name],
                },
              ];
            }),
          ),
        catch: (cause) => new StackConfigError({ message: String(cause) }),
      });
      const functionsEnv = yield* Effect.try({
        try: () =>
          Object.fromEntries(
            Object.entries(validatedConfig.edge_runtime.secrets ?? {}).map(([key, value]) => [
              key,
              value ?? "",
            ]),
          ),
        catch: (cause) => new StackConfigError({ message: String(cause) }),
      });
      const storageFileSizeLimit = yield* Effect.try({
        try: () => String(parseFileSizeLimit(validatedConfig.storage.file_size_limit)),
        catch: (cause) =>
          new StackConfigError({ message: `Invalid storage.file_size_limit: ${String(cause)}` }),
      });
      const healthTimeoutMs = yield* Effect.try({
        try: () => parseDuration(validatedConfig.db.health_timeout) / 1_000_000,
        catch: (cause) =>
          new StackConfigError({ message: `Invalid db.health_timeout: ${String(cause)}` }),
      });
      const configuredJwtSecret = yield* Effect.try({
        try: () =>
          validatedConfig.auth.jwt_secret === undefined || validatedConfig.auth.jwt_secret === ""
            ? undefined
            : resolveJwtSecret(validatedConfig.auth.jwt_secret),
        catch: (cause) => new StackConfigError({ message: String(cause) }),
      });
      const jwtSecret =
        configuredJwtSecret === undefined ? undefined : Redacted.make(configuredJwtSecret);
      const rootKey = yield* snapshot.get(CliConfigKeys.db.rootKey).pipe(
        Effect.map(({ value, origin }) =>
          origin.tier === "default" || value === "" ? undefined : value,
        ),
        Effect.mapError(toStackConfigError),
      );
      const configuredPort = (path: string, port: number) =>
        originAt(path).tier === "default" ? undefined : port;
      const dbPort = configuredPort("db.port", validatedConfig.db.port);
      const apiPort = configuredPort("api.port", validatedConfig.api.port);
      const studioPort = configuredPort("studio.port", validatedConfig.studio.port);
      const poolerPort = configuredPort("db.pooler.port", validatedConfig.db.pooler.port);
      const mailPort = configuredPort("local_smtp.port", validatedConfig.local_smtp.port);
      const mailSmtpPort = configuredPort(
        "local_smtp.smtp_port",
        validatedConfig.local_smtp.smtp_port ?? 0,
      );
      const mailPop3Port = configuredPort(
        "local_smtp.pop3_port",
        validatedConfig.local_smtp.pop3_port ?? 0,
      );
      const analyticsPort = configuredPort("analytics.port", validatedConfig.analytics.port);
      const poolMode =
        validatedConfig.db.pooler.pool_mode === "session" ? ("session" as const) : "transaction";
      const storagePath = `${projectRoot}/supabase/.temp/stack-uploads`;
      const pgmetaCreation: ServiceCreationType = {
        service: "pgmeta",
        config: {},
        endpoints: { http: endpoint(undefined) },
      };
      const createCreations = (
        stackId: string,
      ): Effect.Effect<ReadonlyArray<ServiceCreationType>, StackConfigError> =>
        Effect.sync(() => {
          return [
            {
              service: "database",
              config: {
                version: String(validatedConfig.db.major_version),
                ...(jwtSecret === undefined ? {} : { jwtSecret }),
                jwtExpiry: validatedConfig.auth.jwt_expiry,
                settings: validatedConfig.db.settings,
                healthTimeoutMs,
                ...(rootKey === undefined ? {} : { rootKey: Redacted.make(rootKey) }),
              },
              endpoints: { sql: endpoint(dbPort) },
            },
            ...(validatedConfig.analytics.enabled
              ? [
                  {
                    service: "analytics" as const,
                    config: {
                      backend: "postgres" as const,
                      apiKey: "api-key",
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
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
                      poolMode,
                      tenant: "pooler-dev",
                      defaultPoolSize: validatedConfig.db.pooler.default_pool_size,
                      maxClientConnections: validatedConfig.db.pooler.max_client_conn,
                    },
                    endpoints: { http: endpoint(undefined), sql: endpoint(poolerPort) },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.studio.enabled ? [pgmetaCreation] : []),
            ...(validatedConfig.api.enabled
              ? [
                  {
                    service: "rest" as const,
                    config: {
                      schemas: validatedConfig.api.schemas.join(","),
                      extraSearchPath: validatedConfig.api.extra_search_path.join(","),
                      maxRows: validatedConfig.api.max_rows,
                      ...(validatedConfig.api.external_url === undefined
                        ? {}
                        : { externalApiUrl: validatedConfig.api.external_url }),
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
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
                      ...authConfig,
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
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
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
                      ipVersion:
                        validatedConfig.realtime.ip_version === "IPv6"
                          ? ("IPv6" as const)
                          : ("IPv4" as const),
                      maxHeaderLength: validatedConfig.realtime.max_header_length,
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
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
                      filePath: `${storagePath}/${stackId}`,
                      fileSizeLimit: storageFileSizeLimit,
                      s3ProtocolEnabled: validatedConfig.storage.s3_protocol.enabled,
                      s3AccessKeyId: DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
                      s3SecretAccessKey: DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
                      s3Region: DEFAULT_LOCAL_S3_REGION,
                      vectorEnabled: validatedConfig.storage.vector.enabled,
                      vectorMaxBuckets: validatedConfig.storage.vector.max_buckets,
                      vectorMaxIndexes: validatedConfig.storage.vector.max_indexes,
                    },
                    endpoints: { http: endpoint(apiPort) },
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
            ...(validatedConfig.edge_runtime.enabled
              ? [
                  {
                    service: "functions" as const,
                    config: {
                      functionsRoot: `${projectRoot}/supabase/functions`,
                      filesRoot: projectRoot,
                      functions,
                      env: functionsEnv,
                      policy: validatedConfig.edge_runtime.policy,
                      verifyJwt: true,
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
                    },
                    endpoints: {
                      http: endpoint(apiPort),
                      inspector: endpoint(
                        configuredPort(
                          "edge_runtime.inspector_port",
                          validatedConfig.edge_runtime.inspector_port,
                        ),
                      ),
                    },
                  } satisfies ServiceCreationType,
                ]
              : []),
            ...(validatedConfig.studio.enabled
              ? [
                  {
                    service: "studio" as const,
                    config: {
                      snippetsRoot: `${projectRoot}/supabase/snippets`,
                      apiSchemas: validatedConfig.api.schemas.join(","),
                      apiExtraSearchPath: validatedConfig.api.extra_search_path.join(","),
                      apiMaxRows: validatedConfig.api.max_rows,
                      cliVersion: CLI_VERSION,
                      ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.value(jwtSecret) }),
                      ...(validatedConfig.studio.openai_api_key === undefined
                        ? {}
                        : { openaiApiKey: validatedConfig.studio.openai_api_key }),
                      ...(validatedConfig.studio.api_url === getDefaultCliConfig().studio.api_url
                        ? {}
                        : { publicApiUrl: validatedConfig.studio.api_url }),
                    },
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
        creations: createCreations,
        source: validatedConfig,
        projectEnvValues,
        originAt,
        remoteJwks,
        keys,
      };
    }),
);

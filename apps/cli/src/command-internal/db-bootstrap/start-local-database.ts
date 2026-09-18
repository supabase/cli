/**
 * Plain local-database start shared by `supabase db start` and the declarative `--local` paths.
 * Self-contained: resolves its own services, reports progress via `output.raw` only, and never
 * flushes telemetry.
 *
 * "Already running" is a success here, and callers print it differently (`db start` prints a
 * message, the declarative seam stays silent), so this returns a
 * {@link StartLocalDatabaseResult} discriminator instead of printing the terminal line itself.
 */

import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { NetworkIdFlag, resolveDebugWithProjectEnv } from "../global-flags.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { checkDbToml } from "../db-config.toml-read.ts";
import { DbConfigLoadError } from "../db-config.errors.ts";
import {
  envOverride,
  envOverrideApiMaxRows,
  envOverrideAuthPasswordRequirements,
  envOverrideBool,
  envOverrideDefaultPoolSize,
  envOverrideEdgeRuntimePolicy,
  envOverrideMaxClientConn,
  envOverridePoolMode,
  envOverridePort,
  envOverrideRealtimeIpVersion,
  envOverrideRealtimeMaxHeaderLength,
  envOverrideUint,
  resolveAuthEmail,
  resolveAuthEmailSmtp,
  resolveAuthExternalProviders,
  resolveAuthHooks,
  resolveAuthMfa,
  resolveAuthSms,
  resolveDbSettingsEnvOverrides,
  resolveGotrueOAuthServer,
  resolveGotruePasskeyWebauthn,
  resolveGotrueRateLimit,
  resolveGotrueSessions,
  resolveGotrueWeb3,
  resolveLocalConfigValues,
  resolveThirdPartyProviders,
} from "../local-config-values.ts";
import { parseGoDuration, resolveHealthTimeoutSeconds } from "../go-duration.ts";
import { ramInBytes } from "../size-units.ts";
import { goUrlParse } from "../storage-url.ts";
import { loadLocalProjectContext } from "../local-project-context.ts";
import { cliProjectFilterValue } from "../docker-ids.ts";
import { buildLocalDbContainerInputs } from "./local-container-inputs.ts";
import { isLocalDbRunning } from "./local-db-running.ts";
import { rollbackStart } from "./rollback.ts";
import { startDatabase } from "./start-database.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps a synchronous resolver/parser that throws on a malformed config value into a typed
 * `DbConfigLoadError` failure — mirrors `commands/start/start.handler.ts`'s identical
 * `wrapConfigOverride`: config loading hard-fails on a bad decode before any Docker work runs.
 */
function wrapDbConfigOverride<T>(
  dottedFieldPath: string,
  thunk: () => T,
): Effect.Effect<T, DbConfigLoadError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      new DbConfigLoadError({
        message: `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

type StartLocalDatabaseStatus = "already-running" | "started";

interface StartLocalDatabaseResult {
  readonly status: StartLocalDatabaseStatus;
}

/**
 * Starts the local Postgres database, or no-ops when it is already running. See this module's
 * own header for the full design rationale.
 *
 * `fromBackupFlag` is `db start`'s own `--from-backup` value, resolved against the caller's cwd
 * before being passed in; the declarative seam's `ensureLocalDatabaseStarted` always calls with
 * no argument.
 */
export const startLocalDatabase = Effect.fnUntraced(function* (fromBackupFlag?: string) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const networkIdFlag = yield* NetworkIdFlag;

  // Config is loaded first thing: a missing config is tolerated (defaults), but a present config
  // that is malformed, references an undecryptable `encrypted:` secret, or fails validation
  // aborts before any container work. `checkDbToml` does that load+validate, not
  // `isLocalDbRunning`'s best-effort read, which swallows config errors.
  const dbTomlValues = yield* checkDbToml(fs, path, cliSettings.workdir);

  // Threaded into `rollbackStart`'s own teardown (gates its `Pruned …:` stderr reports) and into
  // `buildLocalDbContainerInputs`'s own `setup.debug`, so a failed fresh-volume migrate job tees
  // its own stderr. Resolved with the `SUPABASE_DEBUG` shell/project-`.env` fallback, not the
  // bare flag.
  const debug = yield* resolveDebugWithProjectEnv(dbTomlValues.projectEnv);

  // The rest of config loading — full decode/resolution plus the eager duration-field
  // validation right below — also runs before the already-running check, so a malformed
  // `auth.*` duration field must fail this call even when Postgres is already running.
  const context = yield* loadLocalProjectContext(
    cliSettings.workdir,
    (message) => new DbConfigLoadError({ message }),
  );
  // This same `context` is passed into `buildLocalDbContainerInputs` below as
  // `preloadedContext`, since a second `loadCliConfig` call would double-print
  // deprecated-config-section warnings; that function returns the same context back verbatim.
  // `hostnameForValidation` here still feeds the discarded `resolveLocalConfigValues` call below.
  const { config, projectEnvValues, loaded, hostname: hostnameForValidation } = context;

  // Every duration config field is decoded in this same unconditional pass, before Docker is
  // touched or the already-running check runs. The parsed values are discarded; only the
  // fail-fast behavior matters.
  const authDocForValidation = asRecord(loaded?.document?.["auth"]);
  const resolvedEmailForValidation = yield* wrapDbConfigOverride("auth.email", () =>
    resolveAuthEmail(config.auth.email, authDocForValidation, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.email.max_frequency", () =>
    parseGoDuration(resolvedEmailForValidation.max_frequency),
  );
  yield* wrapDbConfigOverride("auth.email.smtp", () =>
    resolveAuthEmailSmtp(authDocForValidation, projectEnvValues),
  );
  const smsForValidation = yield* wrapDbConfigOverride("auth.sms", () =>
    resolveAuthSms(authDocForValidation, config.auth.sms, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.sms.max_frequency", () =>
    parseGoDuration(smsForValidation.max_frequency),
  );
  const authEnabledForValidation = envOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  if (
    authEnabledForValidation &&
    !smsForValidation.twilio.enabled &&
    !smsForValidation.twilio_verify.enabled &&
    !smsForValidation.messagebird.enabled &&
    !smsForValidation.textlocal.enabled &&
    !smsForValidation.vonage.enabled &&
    envOverrideBool(
      "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
      config.auth.sms.enable_signup,
      "auth.sms.enable_signup",
      projectEnvValues,
    )
  ) {
    yield* output.raw("WARN: no SMS provider is enabled. Disabling phone login\n", "stderr");
  }
  const gotrueSessionsForValidation = resolveGotrueSessions(config.auth.sessions, projectEnvValues);
  if (gotrueSessionsForValidation?.timebox !== undefined) {
    yield* wrapDbConfigOverride("auth.sessions.timebox", () =>
      parseGoDuration(gotrueSessionsForValidation.timebox!),
    );
  }
  if (gotrueSessionsForValidation?.inactivity_timeout !== undefined) {
    yield* wrapDbConfigOverride("auth.sessions.inactivity_timeout", () =>
      parseGoDuration(gotrueSessionsForValidation.inactivity_timeout!),
    );
  }
  yield* wrapDbConfigOverride("auth.mfa.phone.max_frequency", () =>
    parseGoDuration(resolveAuthMfa(config.auth.mfa, projectEnvValues).phone.max_frequency),
  );
  yield* wrapDbConfigOverride("auth.rate_limit", () =>
    resolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.jwt_expiry", () =>
    envOverrideUint(
      "SUPABASE_AUTH_JWT_EXPIRY",
      "auth.jwt_expiry",
      config.auth.jwt_expiry,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_signup", () =>
    envOverrideBool(
      "SUPABASE_AUTH_ENABLE_SIGNUP",
      config.auth.enable_signup,
      "auth.enable_signup",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_anonymous_sign_ins", () =>
    envOverrideBool(
      "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
      config.auth.enable_anonymous_sign_ins,
      "auth.enable_anonymous_sign_ins",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_refresh_token_rotation", () =>
    envOverrideBool(
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      config.auth.enable_refresh_token_rotation,
      "auth.enable_refresh_token_rotation",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.refresh_token_reuse_interval", () =>
    envOverrideUint(
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      "auth.refresh_token_reuse_interval",
      config.auth.refresh_token_reuse_interval,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_manual_linking", () =>
    envOverrideBool(
      "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
      config.auth.enable_manual_linking,
      "auth.enable_manual_linking",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.minimum_password_length", () =>
    envOverrideUint(
      "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
      "auth.minimum_password_length",
      config.auth.minimum_password_length,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.password_requirements", () =>
    envOverrideAuthPasswordRequirements(config.auth.password_requirements, projectEnvValues),
  );

  yield* wrapDbConfigOverride("auth.web3", () =>
    resolveGotrueWeb3(config.auth.web3, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.oauth_server", () =>
    resolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.passkey", () =>
    resolveGotruePasskeyWebauthn(loaded?.document, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.external", () =>
    resolveAuthExternalProviders(authDocForValidation, config.auth.external, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.third_party", () =>
    resolveThirdPartyProviders(config.auth.third_party, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.hook", () =>
    resolveAuthHooks(authDocForValidation, config.auth.hook, projectEnvValues),
  );

  yield* wrapDbConfigOverride("api.enabled", () =>
    envOverrideBool("SUPABASE_API_ENABLED", config.api.enabled, "api.enabled", projectEnvValues),
  );
  yield* wrapDbConfigOverride("api.tls.enabled", () =>
    envOverrideBool(
      "SUPABASE_API_TLS_ENABLED",
      config.api.tls.enabled,
      "api.tls.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("api.max_rows", () =>
    envOverrideApiMaxRows(config.api.max_rows, projectEnvValues),
  );
  yield* wrapDbConfigOverride("api.port", () =>
    envOverridePort("SUPABASE_API_PORT", config.api.port, "api.port", projectEnvValues),
  );

  yield* wrapDbConfigOverride("storage.vector.enabled", () =>
    envOverrideBool(
      "SUPABASE_STORAGE_VECTOR_ENABLED",
      config.storage.vector.enabled,
      "storage.vector.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.s3_protocol.enabled", () =>
    envOverrideBool(
      "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
      config.storage.s3_protocol.enabled,
      "storage.s3_protocol.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.enabled", () =>
    envOverrideBool(
      "SUPABASE_STORAGE_ANALYTICS_ENABLED",
      config.storage.analytics.enabled,
      "storage.analytics.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.max_namespaces", () =>
    envOverrideUint(
      "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
      "storage.analytics.max_namespaces",
      config.storage.analytics.max_namespaces,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.max_tables", () =>
    envOverrideUint(
      "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
      "storage.analytics.max_tables",
      config.storage.analytics.max_tables,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.max_catalogs", () =>
    envOverrideUint(
      "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
      "storage.analytics.max_catalogs",
      config.storage.analytics.max_catalogs,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.vector.max_buckets", () =>
    envOverrideUint(
      "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
      "storage.vector.max_buckets",
      config.storage.vector.max_buckets,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.vector.max_indexes", () =>
    envOverrideUint(
      "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
      "storage.vector.max_indexes",
      config.storage.vector.max_indexes,
      projectEnvValues,
    ),
  );
  const imageTransformationSectionPresent =
    asRecord(asRecord(loaded?.document?.["storage"])?.["image_transformation"]) !== undefined;
  if (imageTransformationSectionPresent) {
    yield* wrapDbConfigOverride("storage.image_transformation.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
        config.storage.image_transformation?.enabled ?? false,
        "storage.image_transformation.enabled",
        projectEnvValues,
      ),
    );
  }

  const localSmtpPortForValidation = yield* wrapDbConfigOverride("local_smtp.port", () =>
    envOverridePort(
      "SUPABASE_LOCAL_SMTP_PORT",
      config.local_smtp.port,
      "local_smtp.port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("local_smtp.smtp_port", () =>
    envOverridePort(
      "SUPABASE_LOCAL_SMTP_SMTP_PORT",
      config.local_smtp.smtp_port ?? 0,
      "local_smtp.smtp_port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("local_smtp.pop3_port", () =>
    envOverridePort(
      "SUPABASE_LOCAL_SMTP_POP3_PORT",
      config.local_smtp.pop3_port ?? 0,
      "local_smtp.pop3_port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("analytics.port", () =>
    envOverridePort(
      "SUPABASE_ANALYTICS_PORT",
      config.analytics.port,
      "analytics.port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("analytics.vector_port", () =>
    envOverridePort(
      "SUPABASE_ANALYTICS_VECTOR_PORT",
      config.analytics.vector_port ?? 0,
      "analytics.vector_port",
      projectEnvValues,
    ),
  );

  yield* wrapDbConfigOverride("db.pooler.enabled", () =>
    envOverrideBool(
      "SUPABASE_DB_POOLER_ENABLED",
      config.db.pooler.enabled,
      "db.pooler.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("db.pooler.port", () =>
    envOverridePort(
      "SUPABASE_DB_POOLER_PORT",
      config.db.pooler.port,
      "db.pooler.port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("db.pooler.pool_mode", () =>
    envOverridePoolMode(config.db.pooler.pool_mode, projectEnvValues),
  );
  yield* wrapDbConfigOverride("db.pooler.default_pool_size", () =>
    envOverrideDefaultPoolSize(config.db.pooler.default_pool_size, projectEnvValues),
  );
  yield* wrapDbConfigOverride("db.pooler.max_client_conn", () =>
    envOverrideMaxClientConn(config.db.pooler.max_client_conn, projectEnvValues),
  );

  yield* wrapDbConfigOverride("edge_runtime.policy", () =>
    envOverrideEdgeRuntimePolicy(config.edge_runtime.policy, projectEnvValues),
  );
  yield* wrapDbConfigOverride("edge_runtime.inspector_port", () =>
    envOverridePort(
      "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
      config.edge_runtime.inspector_port,
      "edge_runtime.inspector_port",
      projectEnvValues,
    ),
  );

  yield* wrapDbConfigOverride("realtime.ip_version", () =>
    envOverrideRealtimeIpVersion(config.realtime.ip_version, projectEnvValues),
  );
  yield* wrapDbConfigOverride("realtime.max_header_length", () =>
    envOverrideRealtimeMaxHeaderLength(config.realtime.max_header_length, projectEnvValues),
  );

  yield* wrapDbConfigOverride("db.settings", () =>
    resolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues),
  );

  yield* wrapDbConfigOverride("realtime.enabled", () =>
    envOverrideBool(
      "SUPABASE_REALTIME_ENABLED",
      config.realtime.enabled,
      "realtime.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.enabled", () =>
    envOverrideBool(
      "SUPABASE_STORAGE_ENABLED",
      config.storage.enabled,
      "storage.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.file_size_limit", () =>
    ramInBytes(
      envOverride(
        "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
        config.storage.file_size_limit,
        projectEnvValues,
      ) ?? config.storage.file_size_limit,
    ),
  );
  yield* wrapDbConfigOverride("db.health_timeout", () =>
    resolveHealthTimeoutSeconds(
      envOverride("SUPABASE_DB_HEALTH_TIMEOUT", config.db.health_timeout, projectEnvValues) ??
        config.db.health_timeout,
    ),
  );

  yield* wrapDbConfigOverride("edge_runtime.enabled", () =>
    envOverrideBool(
      "SUPABASE_EDGE_RUNTIME_ENABLED",
      config.edge_runtime.enabled,
      "edge_runtime.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("db.network_restrictions.enabled", () =>
    envOverrideBool(
      "SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED",
      config.db.network_restrictions.enabled,
      "db.network_restrictions.enabled",
      projectEnvValues,
    ),
  );
  const sslEnforcementSectionPresent =
    asRecord(asRecord(loaded?.document?.["db"])?.["ssl_enforcement"]) !== undefined;
  if (sslEnforcementSectionPresent) {
    yield* wrapDbConfigOverride("db.ssl_enforcement.enabled", () =>
      envOverrideBool(
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED",
        config.db.ssl_enforcement?.enabled ?? false,
        "db.ssl_enforcement.enabled",
        projectEnvValues,
      ),
    );
  }
  const studioEnabledForValidation = yield* wrapDbConfigOverride("studio.enabled", () =>
    envOverrideBool(
      "SUPABASE_STUDIO_ENABLED",
      config.studio.enabled,
      "studio.enabled",
      projectEnvValues,
    ),
  );
  const studioPortForValidation = yield* wrapDbConfigOverride("studio.port", () =>
    envOverridePort("SUPABASE_STUDIO_PORT", config.studio.port, "studio.port", projectEnvValues),
  );
  if (studioEnabledForValidation && studioPortForValidation === 0) {
    yield* Effect.fail(
      new DbConfigLoadError({ message: "Missing required field in config: studio.port" }),
    );
  }
  const studioApiUrlForValidation =
    envOverride("SUPABASE_STUDIO_API_URL", config.studio.api_url, projectEnvValues) ??
    config.studio.api_url;
  if (studioEnabledForValidation) {
    yield* Effect.try({
      try: () => goUrlParse(studioApiUrlForValidation),
      catch: (cause) =>
        new DbConfigLoadError({
          message: `Invalid config for studio.api_url: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
  }
  const localSmtpEnabledForValidation = yield* wrapDbConfigOverride("local_smtp.enabled", () =>
    envOverrideBool(
      "SUPABASE_LOCAL_SMTP_ENABLED",
      config.local_smtp.enabled,
      "local_smtp.enabled",
      projectEnvValues,
    ),
  );
  if (localSmtpEnabledForValidation && localSmtpPortForValidation === 0) {
    yield* Effect.fail(
      new DbConfigLoadError({ message: "Missing required field in config: local_smtp.port" }),
    );
  }

  // `resolveLocalConfigValues` is the same resolver `buildLocalDbContainerInputs` calls again
  // below to build the real `values`. Calling it eagerly here too forces its internal
  // decode-time throws (auth.captcha, jwt_secret length, signing_keys_path, api.tls cert/key
  // reads, auth.external required fields, email/notification template reads) to surface before
  // the already-running shortcut. The result is discarded; `buildLocalDbContainerInputs` below
  // re-resolves the real values.
  yield* Effect.try({
    try: () =>
      resolveLocalConfigValues(
        config,
        hostnameForValidation,
        cliSettings.workdir,
        projectEnvValues,
        loaded?.document,
      ),
    catch: (cause) =>
      new DbConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  // If the db container is already up, tell the caller and stop here. Runs after the config
  // load/validation above.
  const running = yield* isLocalDbRunning(
    spawner,
    fs,
    path,
    cliSettings.workdir,
    Option.getOrUndefined(cliSettings.projectId),
  );
  if (running) {
    return { status: "already-running" } satisfies StartLocalDatabaseResult;
  }

  // Resolve a relative `--from-backup` against the caller's cwd, captured before any workdir
  // change. An empty `--from-backup ""` is a normal no-backup start, so treat it as absent
  // rather than joining it to a directory path.
  const fromBackup =
    fromBackupFlag === undefined || fromBackupFlag === ""
      ? undefined
      : path.isAbsolute(fromBackupFlag)
        ? fromBackupFlag
        : path.join(runtimeInfo.cwd, fromBackupFlag);

  // Not running → bring up the container natively. `context` (loaded eagerly above) is threaded
  // through as `preloadedContext` so this call reuses it instead of calling
  // `loadLocalProjectContext` a second time, which would double-print deprecated-config-section
  // warnings.
  const inputs = yield* buildLocalDbContainerInputs(
    spawner,
    cliSettings.workdir,
    networkIdFlag,
    runtimeInfo.platform,
    debug,
    undefined,
    undefined,
    context,
  );
  const {
    context: { projectId, hostname },
    values,
    bootstrapConfig,
    networkId,
    containerOpts,
    dbContainerId,
    postgresSpecBase,
    resolvePostgresImage,
    setup,
  } = inputs;

  const filterValue = cliProjectFilterValue(projectId);

  // Assigned by `startDatabase`'s own pre-create volume-existence check; defaults to
  // `false` so a rollback triggered by an earlier failure (e.g. network creation) never
  // deletes a volume this run never confirmed was fresh.
  let isFreshVolume = false;

  // Runs the exact start-database sequence (network -> volume probe -> container create+start
  // -> health wait -> fresh-volume setup -> `_current_branch`) — shared with `supabase start`,
  // see `startDatabase`'s own header. Any failure rolls back via the same `Effect.onError`
  // wrapper `supabase start` uses.
  yield* startDatabase(spawner, {
    fs,
    path,
    workdir: cliSettings.workdir,
    projectId,
    networkId,
    hostname,
    dbContainerId,
    dbPort: values.dbPort,
    containerOpts,
    // `db reset` has no `fromBackup` concept at all, so `postgresSpecBase` omits it.
    postgresSpec: { ...postgresSpecBase, fromBackup },
    // Only the `db` container's own image, resolved lazily, right where it would be
    // resolved internally otherwise — no other service's image is pre-pulled here.
    resolvePostgresImage,
    dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
    setup,
    webhooksEnabled: dbTomlValues.webhooksEnabled,
    onFreshVolumeResolved: (resolved) => {
      isFreshVolume = resolved;
    },
  }).pipe(
    Effect.onError(() =>
      rollbackStart(spawner, filterValue, isFreshVolume, cliSettings.workdir, debug),
    ),
  );

  return { status: "started" } satisfies StartLocalDatabaseResult;
});

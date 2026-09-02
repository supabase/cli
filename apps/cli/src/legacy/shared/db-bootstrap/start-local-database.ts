/**
 * A plain local-database start — Go's `start.Run(ctx, "", fsys)` (the DB-only start path
 * `supabase db start` and, on the declarative `--local` paths, `ensureLocalDatabaseStarted`
 * both call — `apps/cli-go/cmd/db_schema_declarative.go:149-158`, deleted in CLI-1970; last
 * present at commit 7b469f5b3). Hoisted out of `commands/db/start/start.handler.ts` (CLI-1970)
 * so it is callable in-process by any Effect context that provides the services below, following
 * the same precedent `reset-local-database.ts` established for `db reset`: resolves every
 * service it needs itself (self-contained, not passed in by the caller), emits progress via
 * `output.raw` only, and never flushes telemetry — that stays the top-level command's own
 * concern (`db start`'s handler wraps this call in its own `Effect.ensuring(telemetryState.flush)`;
 * the declarative seam's `ensureLocalDatabaseStarted` does not flush at all, matching Go, where
 * `ensureLocalDatabaseStarted` runs inside the OUTER `db schema declarative generate`/`sync`
 * command's own `PersistentPostRun`, not a second, independent one).
 *
 * Unlike `legacyResetLocalDatabase`, "the database is already running" is a normal, successful
 * outcome here, not a failure — and the two real callers want different observable behavior on
 * that outcome: `db start`'s own handler prints "Postgres database is already running." (Go's
 * `db start` binary), while the declarative seam's `ensureLocalDatabaseStarted` must stay
 * silent (Go's `ensureLocalDatabaseStarted` never runs `start.Run` at all when
 * `AssertSupabaseDbIsRunning` reports the container is up, so nothing it wraps ever prints
 * anything on that path). So this function itself never prints the terminal-state line — it
 * returns a {@link LegacyStartLocalDatabaseResult} discriminator and leaves the print (or lack of
 * one) to the caller, exactly like `db start`'s own pre-existing `output.success` on completion is
 * also the caller's concern (see this module's own precedent: `legacyStartDatabase`'s header,
 * "Rollback ... is ALSO the caller's concern, not this function's").
 */

import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  LegacyNetworkIdFlag,
  legacyResolveDebugWithProjectEnv,
} from "../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../config/legacy-cli-settings.service.ts";
import { legacyCheckDbToml } from "../legacy-db-config.toml-read.ts";
import { LegacyDbConfigLoadError } from "../legacy-db-config.errors.ts";
import {
  legacyEnvOverride,
  legacyEnvOverrideApiMaxRows,
  legacyEnvOverrideAuthPasswordRequirements,
  legacyEnvOverrideBool,
  legacyEnvOverrideDefaultPoolSize,
  legacyEnvOverrideEdgeRuntimePolicy,
  legacyEnvOverrideMaxClientConn,
  legacyEnvOverridePoolMode,
  legacyEnvOverridePort,
  legacyEnvOverrideRealtimeIpVersion,
  legacyEnvOverrideRealtimeMaxHeaderLength,
  legacyEnvOverrideUint,
  legacyResolveAuthEmail,
  legacyResolveAuthEmailSmtp,
  legacyResolveAuthExternalProviders,
  legacyResolveAuthHooks,
  legacyResolveAuthMfa,
  legacyResolveAuthSms,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveGotrueOAuthServer,
  legacyResolveGotruePasskeyWebauthn,
  legacyResolveGotrueRateLimit,
  legacyResolveGotrueSessions,
  legacyResolveGotrueWeb3,
  legacyResolveLocalConfigValues,
  legacyResolveThirdPartyProviders,
} from "../legacy-local-config-values.ts";
import { legacyParseGoDuration, legacyResolveHealthTimeoutSeconds } from "../legacy-go-duration.ts";
import { ramInBytes } from "../legacy-size-units.ts";
import { legacyGoUrlParse } from "../legacy-storage-url.ts";
import { legacyLoadLocalProjectContext } from "../legacy-local-project-context.ts";
import { legacyCliProjectFilterValue } from "../legacy-docker-ids.ts";
import { legacyBuildLocalDbContainerInputs } from "./local-container-inputs.ts";
import { legacyIsLocalDbRunning } from "./local-db-running.ts";
import { legacyRollbackStart } from "./rollback.ts";
import { legacyStartDatabase } from "./start-database.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps a synchronous resolver/parser that throws on a malformed config value into a typed
 * `LegacyDbConfigLoadError` failure — mirrors `commands/start/start.handler.ts`'s identical
 * `wrapConfigOverride`: config loading hard-fails on a bad decode before any Docker work runs.
 */
function wrapDbConfigOverride<T>(
  dottedFieldPath: string,
  thunk: () => T,
): Effect.Effect<T, LegacyDbConfigLoadError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      new LegacyDbConfigLoadError({
        message: `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

type LegacyStartLocalDatabaseStatus = "already-running" | "started";

interface LegacyStartLocalDatabaseResult {
  readonly status: LegacyStartLocalDatabaseStatus;
}

/**
 * Starts the local Postgres database, or no-ops when it is already running. See this module's
 * own header for the full design rationale. Mirrors Go's `start.Run(ctx, "", fsys)` — the DB-only
 * `internal/db/start.Run`, not the full `supabase start` stack.
 *
 * `fromBackupFlag` is `db start`'s own `--from-backup` value, resolved against the CALLER's cwd
 * before being passed in; the declarative seam's `ensureLocalDatabaseStarted` always calls with
 * no argument, matching Go's `start.Run(ctx, "", fsys)` empty-backup-path literal.
 */
export const legacyStartLocalDatabase = Effect.fnUntraced(function* (fromBackupFlag?: string) {
  const output = yield* Output;
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const networkIdFlag = yield* LegacyNetworkIdFlag;

  // Config is loaded first thing: a missing config is tolerated (defaults), but a present
  // config that is malformed, references an undecryptable `encrypted:` secret, or fails
  // validation aborts before any container work. `legacyCheckDbToml` is that exact
  // load+validate — call it here (not via `legacyIsLocalDbRunning`'s best-effort read, which
  // swallows config errors) so a start fails fast on a broken config.
  const dbTomlValues = yield* legacyCheckDbToml(fs, path, cliSettings.workdir);

  // Threaded into `legacyRollbackStart`'s own `legacyDockerRemoveAll` teardown —
  // `--debug` gates that function's `Pruned …:` stderr reports, matching
  // `supabase start`'s own handler — and into
  // `legacyBuildLocalDbContainerInputs`'s own `setup.debug`, so a failed fresh-volume
  // Realtime/Storage/Auth migrate job tees its own stderr (`db-setup.ts`'s
  // `legacyRunStartMigrateJob`). Resolved with the `SUPABASE_DEBUG` shell/project-`.env`
  // fallback, not the bare flag: every Go debug read on this path went through
  // `viper.GetBool("DEBUG")` under `AutomaticEnv`, and the sibling shadow-provision path
  // (`legacy-pgdelta.cache.ts`'s `legacyBuildShadowCatalogInputs`) already resolves it the
  // same way.
  const debug = yield* legacyResolveDebugWithProjectEnv(dbTomlValues.projectEnv);

  // The rest of config loading — full config decode/resolution (`legacyLoadLocalProjectContext`)
  // plus the eager duration-field validation right below — ALSO runs before the
  // already-running check, so a malformed `auth.*` duration field must fail this call even
  // when Postgres is already running, not just on a fresh start.
  const context = yield* legacyLoadLocalProjectContext(
    cliSettings.workdir,
    (message) => new LegacyDbConfigLoadError({ message }),
  );
  // `projectId`/`hostname` are NOT destructured under their bare names here — the not-running
  // branch below passes this SAME `context` into `legacyBuildLocalDbContainerInputs` as its
  // `preloadedContext` param (reused, not reloaded — a second `legacyLoadLocalProjectContext`
  // call would run `@supabase/config`'s `loadCliConfig` again, which unconditionally
  // prints deprecated-config-section WARN lines to stderr, doubling them for one invocation),
  // and that function returns the SAME context back verbatim as `inputs.context`, later
  // destructured under `context.projectId`/`context.hostname` — re-declaring those same bare
  // names here, in this same function scope, would still collide with that later
  // destructuring. `hostnameForValidation` is still needed here, for the eager, discarded
  // `legacyResolveLocalConfigValues` call further down.
  const { config, projectEnvValues, loaded, hostname: hostnameForValidation } = context;

  // Every duration config field — including these 5 — is decoded in the same single,
  // unconditional config-load pass, before Docker is touched (or even whether Postgres is
  // already running is checked) at all. Discarding the parsed values: only the fail-fast
  // behavior matters here.
  const authDocForValidation = asRecord(loaded?.document?.["auth"]);
  const resolvedEmailForValidation = yield* wrapDbConfigOverride("auth.email", () =>
    legacyResolveAuthEmail(config.auth.email, authDocForValidation, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.email.max_frequency", () =>
    legacyParseGoDuration(resolvedEmailForValidation.max_frequency),
  );
  yield* wrapDbConfigOverride("auth.email.smtp", () =>
    legacyResolveAuthEmailSmtp(authDocForValidation, projectEnvValues),
  );
  const smsForValidation = yield* wrapDbConfigOverride("auth.sms", () =>
    legacyResolveAuthSms(authDocForValidation, config.auth.sms, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.sms.max_frequency", () =>
    legacyParseGoDuration(smsForValidation.max_frequency),
  );
  const authEnabledForValidation = legacyEnvOverrideBool(
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
    legacyEnvOverrideBool(
      "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
      config.auth.sms.enable_signup,
      "auth.sms.enable_signup",
      projectEnvValues,
    )
  ) {
    yield* output.raw("WARN: no SMS provider is enabled. Disabling phone login\n", "stderr");
  }
  const gotrueSessionsForValidation = legacyResolveGotrueSessions(
    config.auth.sessions,
    projectEnvValues,
  );
  if (gotrueSessionsForValidation?.timebox !== undefined) {
    yield* wrapDbConfigOverride("auth.sessions.timebox", () =>
      legacyParseGoDuration(gotrueSessionsForValidation.timebox!),
    );
  }
  if (gotrueSessionsForValidation?.inactivity_timeout !== undefined) {
    yield* wrapDbConfigOverride("auth.sessions.inactivity_timeout", () =>
      legacyParseGoDuration(gotrueSessionsForValidation.inactivity_timeout!),
    );
  }
  yield* wrapDbConfigOverride("auth.mfa.phone.max_frequency", () =>
    legacyParseGoDuration(
      legacyResolveAuthMfa(config.auth.mfa, projectEnvValues).phone.max_frequency,
    ),
  );
  yield* wrapDbConfigOverride("auth.rate_limit", () =>
    legacyResolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.jwt_expiry", () =>
    legacyEnvOverrideUint(
      "SUPABASE_AUTH_JWT_EXPIRY",
      "auth.jwt_expiry",
      config.auth.jwt_expiry,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_signup", () =>
    legacyEnvOverrideBool(
      "SUPABASE_AUTH_ENABLE_SIGNUP",
      config.auth.enable_signup,
      "auth.enable_signup",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_anonymous_sign_ins", () =>
    legacyEnvOverrideBool(
      "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
      config.auth.enable_anonymous_sign_ins,
      "auth.enable_anonymous_sign_ins",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_refresh_token_rotation", () =>
    legacyEnvOverrideBool(
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      config.auth.enable_refresh_token_rotation,
      "auth.enable_refresh_token_rotation",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.refresh_token_reuse_interval", () =>
    legacyEnvOverrideUint(
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      "auth.refresh_token_reuse_interval",
      config.auth.refresh_token_reuse_interval,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.enable_manual_linking", () =>
    legacyEnvOverrideBool(
      "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
      config.auth.enable_manual_linking,
      "auth.enable_manual_linking",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.minimum_password_length", () =>
    legacyEnvOverrideUint(
      "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
      "auth.minimum_password_length",
      config.auth.minimum_password_length,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.password_requirements", () =>
    legacyEnvOverrideAuthPasswordRequirements(config.auth.password_requirements, projectEnvValues),
  );

  yield* wrapDbConfigOverride("auth.web3", () =>
    legacyResolveGotrueWeb3(config.auth.web3, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.oauth_server", () =>
    legacyResolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.passkey", () =>
    legacyResolveGotruePasskeyWebauthn(loaded?.document, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.external", () =>
    legacyResolveAuthExternalProviders(
      authDocForValidation,
      config.auth.external,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("auth.third_party", () =>
    legacyResolveThirdPartyProviders(config.auth.third_party, projectEnvValues),
  );
  yield* wrapDbConfigOverride("auth.hook", () =>
    legacyResolveAuthHooks(authDocForValidation, config.auth.hook, projectEnvValues),
  );

  yield* wrapDbConfigOverride("api.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_API_ENABLED",
      config.api.enabled,
      "api.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("api.tls.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_API_TLS_ENABLED",
      config.api.tls.enabled,
      "api.tls.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("api.max_rows", () =>
    legacyEnvOverrideApiMaxRows(config.api.max_rows, projectEnvValues),
  );
  yield* wrapDbConfigOverride("api.port", () =>
    legacyEnvOverridePort("SUPABASE_API_PORT", config.api.port, "api.port", projectEnvValues),
  );

  yield* wrapDbConfigOverride("storage.vector.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_STORAGE_VECTOR_ENABLED",
      config.storage.vector.enabled,
      "storage.vector.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.s3_protocol.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
      config.storage.s3_protocol.enabled,
      "storage.s3_protocol.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_STORAGE_ANALYTICS_ENABLED",
      config.storage.analytics.enabled,
      "storage.analytics.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.max_namespaces", () =>
    legacyEnvOverrideUint(
      "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
      "storage.analytics.max_namespaces",
      config.storage.analytics.max_namespaces,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.max_tables", () =>
    legacyEnvOverrideUint(
      "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
      "storage.analytics.max_tables",
      config.storage.analytics.max_tables,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.analytics.max_catalogs", () =>
    legacyEnvOverrideUint(
      "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
      "storage.analytics.max_catalogs",
      config.storage.analytics.max_catalogs,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.vector.max_buckets", () =>
    legacyEnvOverrideUint(
      "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
      "storage.vector.max_buckets",
      config.storage.vector.max_buckets,
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.vector.max_indexes", () =>
    legacyEnvOverrideUint(
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
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
        config.storage.image_transformation?.enabled ?? false,
        "storage.image_transformation.enabled",
        projectEnvValues,
      ),
    );
  }

  const localSmtpPortForValidation = yield* wrapDbConfigOverride("local_smtp.port", () =>
    legacyEnvOverridePort(
      "SUPABASE_LOCAL_SMTP_PORT",
      config.local_smtp.port,
      "local_smtp.port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("local_smtp.smtp_port", () =>
    legacyEnvOverridePort(
      "SUPABASE_LOCAL_SMTP_SMTP_PORT",
      config.local_smtp.smtp_port ?? 0,
      "local_smtp.smtp_port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("local_smtp.pop3_port", () =>
    legacyEnvOverridePort(
      "SUPABASE_LOCAL_SMTP_POP3_PORT",
      config.local_smtp.pop3_port ?? 0,
      "local_smtp.pop3_port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("analytics.port", () =>
    legacyEnvOverridePort(
      "SUPABASE_ANALYTICS_PORT",
      config.analytics.port,
      "analytics.port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("analytics.vector_port", () =>
    legacyEnvOverridePort(
      "SUPABASE_ANALYTICS_VECTOR_PORT",
      config.analytics.vector_port ?? 0,
      "analytics.vector_port",
      projectEnvValues,
    ),
  );

  yield* wrapDbConfigOverride("db.pooler.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_DB_POOLER_ENABLED",
      config.db.pooler.enabled,
      "db.pooler.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("db.pooler.port", () =>
    legacyEnvOverridePort(
      "SUPABASE_DB_POOLER_PORT",
      config.db.pooler.port,
      "db.pooler.port",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("db.pooler.pool_mode", () =>
    legacyEnvOverridePoolMode(config.db.pooler.pool_mode, projectEnvValues),
  );
  yield* wrapDbConfigOverride("db.pooler.default_pool_size", () =>
    legacyEnvOverrideDefaultPoolSize(config.db.pooler.default_pool_size, projectEnvValues),
  );
  yield* wrapDbConfigOverride("db.pooler.max_client_conn", () =>
    legacyEnvOverrideMaxClientConn(config.db.pooler.max_client_conn, projectEnvValues),
  );

  yield* wrapDbConfigOverride("edge_runtime.policy", () =>
    legacyEnvOverrideEdgeRuntimePolicy(config.edge_runtime.policy, projectEnvValues),
  );
  yield* wrapDbConfigOverride("edge_runtime.inspector_port", () =>
    legacyEnvOverridePort(
      "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
      config.edge_runtime.inspector_port,
      "edge_runtime.inspector_port",
      projectEnvValues,
    ),
  );

  yield* wrapDbConfigOverride("realtime.ip_version", () =>
    legacyEnvOverrideRealtimeIpVersion(config.realtime.ip_version, projectEnvValues),
  );
  yield* wrapDbConfigOverride("realtime.max_header_length", () =>
    legacyEnvOverrideRealtimeMaxHeaderLength(config.realtime.max_header_length, projectEnvValues),
  );

  yield* wrapDbConfigOverride("db.settings", () =>
    legacyResolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues),
  );

  yield* wrapDbConfigOverride("realtime.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_REALTIME_ENABLED",
      config.realtime.enabled,
      "realtime.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_STORAGE_ENABLED",
      config.storage.enabled,
      "storage.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("storage.file_size_limit", () =>
    ramInBytes(
      legacyEnvOverride(
        "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
        config.storage.file_size_limit,
        projectEnvValues,
      ) ?? config.storage.file_size_limit,
    ),
  );
  yield* wrapDbConfigOverride("db.health_timeout", () =>
    legacyResolveHealthTimeoutSeconds(
      legacyEnvOverride("SUPABASE_DB_HEALTH_TIMEOUT", config.db.health_timeout, projectEnvValues) ??
        config.db.health_timeout,
    ),
  );

  yield* wrapDbConfigOverride("edge_runtime.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_EDGE_RUNTIME_ENABLED",
      config.edge_runtime.enabled,
      "edge_runtime.enabled",
      projectEnvValues,
    ),
  );
  yield* wrapDbConfigOverride("db.network_restrictions.enabled", () =>
    legacyEnvOverrideBool(
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
      legacyEnvOverrideBool(
        "SUPABASE_DB_SSL_ENFORCEMENT_ENABLED",
        config.db.ssl_enforcement?.enabled ?? false,
        "db.ssl_enforcement.enabled",
        projectEnvValues,
      ),
    );
  }
  const studioEnabledForValidation = yield* wrapDbConfigOverride("studio.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_STUDIO_ENABLED",
      config.studio.enabled,
      "studio.enabled",
      projectEnvValues,
    ),
  );
  const studioPortForValidation = yield* wrapDbConfigOverride("studio.port", () =>
    legacyEnvOverridePort(
      "SUPABASE_STUDIO_PORT",
      config.studio.port,
      "studio.port",
      projectEnvValues,
    ),
  );
  if (studioEnabledForValidation && studioPortForValidation === 0) {
    yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "Missing required field in config: studio.port" }),
    );
  }
  const studioApiUrlForValidation =
    legacyEnvOverride("SUPABASE_STUDIO_API_URL", config.studio.api_url, projectEnvValues) ??
    config.studio.api_url;
  if (studioEnabledForValidation) {
    yield* Effect.try({
      try: () => legacyGoUrlParse(studioApiUrlForValidation),
      catch: (cause) =>
        new LegacyDbConfigLoadError({
          message: `Invalid config for studio.api_url: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
  }
  const localSmtpEnabledForValidation = yield* wrapDbConfigOverride("local_smtp.enabled", () =>
    legacyEnvOverrideBool(
      "SUPABASE_LOCAL_SMTP_ENABLED",
      config.local_smtp.enabled,
      "local_smtp.enabled",
      projectEnvValues,
    ),
  );
  if (localSmtpEnabledForValidation && localSmtpPortForValidation === 0) {
    yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "Missing required field in config: local_smtp.port" }),
    );
  }

  // Closes an entire recurring class of gaps in the battery above, rather than adding another
  // one-off field check: `legacyResolveLocalConfigValues` is the SAME resolver
  // `legacyBuildLocalDbContainerInputs` calls again below, in the not-running branch, to build
  // the REAL `values` the container bring-up needs — calling it EAGERLY here too, before the
  // already-running shortcut, forces its internal decode-time throws (auth.captcha,
  // auth.jwt_secret length, auth.signing_keys_path, api.tls cert/key reads,
  // auth.external.* required-field validation, auth.email/notification template reads) to
  // surface early. Its result is discarded here — only the fail-fast behavior matters — and
  // `legacyBuildLocalDbContainerInputs` below re-resolves the REAL `values`.
  yield* Effect.try({
    try: () =>
      legacyResolveLocalConfigValues(
        config,
        hostnameForValidation,
        cliSettings.workdir,
        projectEnvValues,
        loaded?.document,
      ),
    catch: (cause) =>
      new LegacyDbConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  // If the db container is already up, tell the caller and stop here. Runs AFTER the config
  // load/validation above, matching the established order of loading config before the
  // already-running check.
  const running = yield* legacyIsLocalDbRunning(
    spawner,
    fs,
    path,
    cliSettings.workdir,
    Option.getOrUndefined(cliSettings.projectId),
  );
  if (running) {
    return { status: "already-running" } satisfies LegacyStartLocalDatabaseResult;
  }

  // Resolve a relative `--from-backup` against the CALLER's cwd, captured before any workdir
  // change. An empty `--from-backup ""` is a normal no-backup start, so treat it as absent
  // rather than joining it to a directory path.
  const fromBackup =
    fromBackupFlag === undefined || fromBackupFlag === ""
      ? undefined
      : path.isAbsolute(fromBackupFlag)
        ? fromBackupFlag
        : path.join(runtimeInfo.cwd, fromBackupFlag);

  // Not running → bring up the container natively. `context` (loaded eagerly above) is
  // threaded through as `preloadedContext` — no `projectRef`/`remoteOverrideKeys` (`db start`
  // never has either) — so this call reuses it instead of calling
  // `legacyLoadLocalProjectContext` a second time, which would otherwise double-print any
  // deprecated-config-section stderr warning for this single invocation.
  const inputs = yield* legacyBuildLocalDbContainerInputs(
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

  const filterValue = legacyCliProjectFilterValue(projectId);

  // Assigned by `legacyStartDatabase`'s own pre-create volume-existence check; defaults to
  // `false` so a rollback triggered by an earlier failure (e.g. network creation) never
  // deletes a volume this run never confirmed was fresh.
  let isFreshVolume = false;

  // Runs the exact start-database sequence (network -> volume probe -> container create+start
  // -> health wait -> fresh-volume setup -> `_current_branch`) — shared with `supabase start`,
  // see `legacyStartDatabase`'s own header. Any failure rolls back via the SAME
  // `Effect.onError` wrapper `supabase start` uses.
  yield* legacyStartDatabase(spawner, {
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
      legacyRollbackStart(spawner, filterValue, isFreshVolume, cliSettings.workdir, debug),
    ),
  );

  return { status: "started" } satisfies LegacyStartLocalDatabaseResult;
});

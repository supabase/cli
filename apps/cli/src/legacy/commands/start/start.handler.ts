import { inferFunctionsManifest, type ProjectConfig } from "@supabase/config";
import { Effect, FileSystem, Option, Path, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CLI_VERSION } from "../../../shared/cli/version.ts";
import { rawFunctionConfigRecord } from "../../../shared/functions/deploy.ts";
import {
  resolveFunctionBindMounts,
  toPlainEdgeRuntimeConfig,
  toPlainFunctionRecord,
  type StartedRuntime,
} from "../../../shared/functions/serve.ts";
import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { EventStackStarted } from "../../../shared/telemetry/event-catalog.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveStudioApiUrl } from "../../shared/legacy-api-url.ts";
import { legacyIsBitbucketPipeline } from "../../shared/legacy-bitbucket-pipeline.ts";
import { legacyAqua, legacyYellow } from "../../shared/legacy-colors.ts";
import { legacyResolveApiTlsPath } from "../../shared/legacy-config-validate.ts";
import { LegacyDbConnection } from "../../shared/legacy-db-connection.service.ts";
import { legacyResolveEdgeRuntimeImage } from "../../shared/legacy-edge-runtime-image.ts";
import { legacyResolveDbImage } from "../../shared/legacy-db-image.ts";
import {
  legacyResolveStorageCredentials,
  legacyStorageGatewayFetch,
} from "../../shared/legacy-storage-credentials.ts";
import { readLegacyServiceVersionOverrides } from "../../shared/legacy-service-version-overrides.ts";
import { legacyTempPaths } from "../../shared/legacy-temp-paths.ts";
import { legacyParseGoDuration } from "../../shared/legacy-go-duration.ts";
import {
  LEGACY_CLI_PROJECT_LABEL,
  legacyCliProjectFilterValue,
  legacyServiceContainerIds,
  legacyServiceContainerName,
  localDbContainerId,
  localNetworkId,
} from "../../shared/legacy-docker-ids.ts";
import {
  legacyInspectContainerState,
  legacyListContainersByLabel,
} from "../../shared/legacy-docker-lifecycle.ts";
import {
  envOverride,
  LEGACY_DEPRECATED_EXTERNAL_PROVIDERS,
  legacyEnvOverrideBool,
  legacyEnvOverrideDenoVersion,
  legacyEnvOverrideMajorVersion,
  legacyEnvOverrideRealtimeIpVersion,
  legacyEnvOverrideRealtimeMaxHeaderLength,
  legacyResolveAuthEmailSmtp,
  legacyResolveConfiguredSigningKeys,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveLocalConfigValues,
  legacyResolveLocalJwks,
  type LegacyLocalConfigValues,
} from "../../shared/legacy-local-config-values.ts";
import {
  legacyLoadLocalProjectContext,
  type LegacyLocalProjectContext,
} from "../../shared/legacy-local-project-context.ts";
import { legacySeedBucketsRun } from "../../shared/legacy-seed-buckets.ts";
import {
  LegacyStatusDbInspectError,
  LegacyStatusDbNotReadyError,
  LegacyStatusDbNotRunningError,
  LegacyStatusInvalidConfigError,
  LegacyStatusListError,
} from "../../shared/legacy-status-errors.ts";
import { legacyRenderStatusPretty } from "../../shared/legacy-status-pretty.ts";
import {
  legacyGateStatusState,
  legacyResolveStatusLocalState,
  legacyStatusContainerIds,
  legacyStatusValuesFromState,
} from "../../shared/legacy-status-values.ts";
import { legacyValidateWorkdirIsDirectory } from "../../shared/legacy-workdir-validation.ts";
import type { LegacyStartFlags } from "./start.command.ts";
import {
  LegacyStartConfigLoadError,
  LegacyStartInvalidConfigError,
  LegacyStartWorkdirError,
} from "./start.errors.ts";
import { legacyPartitionStartExcludeFlags } from "./start.exclude.ts";
import {
  legacyStartAlreadyRunningMessage,
  legacyStartCompletedMessage,
  legacyStartSecurityNotice,
  LEGACY_START_STARTING_CONTAINERS_MESSAGE,
  LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
  LEGACY_START_STARTING_DATABASE_MESSAGE,
  LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE,
} from "./start.format.ts";
import {
  legacyResolvePinnedImage,
  legacyResolveStartGates,
  legacyResolveStartImagePlan,
} from "./start.gates.ts";
import { legacyIsUnhealthyStartError, legacyRollbackStart } from "./start.rollback.ts";
import { LEGACY_START_SERVICES } from "./start.services.ts";
import {
  legacyEnsureStartNetwork,
  legacyStartContainer,
  legacyStartVolumeExists,
  type LegacyStartContainerOpts,
} from "./lib/container-lifecycle.ts";
import {
  legacyStartInitCurrentBranch,
  legacyStartSetupLocalDatabase,
  type LegacyStartDbSetupImages,
} from "./lib/db-setup.ts";
import { legacyEnsureImagesCached } from "./lib/image-prepull.ts";
import {
  legacyWaitForHealthyServices,
  type LegacyHealthCheckPostgrestGateway,
} from "./lib/health-check.ts";
import {
  legacyStartInternalDbPassword,
  LEGACY_START_INTERNAL_DB_NAME,
  LEGACY_START_INTERNAL_DB_PORT,
} from "./lib/internal-db-connection.ts";
import {
  LEGACY_KONG_LOCAL_TLS_CERT,
  LEGACY_KONG_LOCAL_TLS_KEY,
} from "./templates/kong-local-tls.ts";
import { legacyBuildLogflareContainerSpec } from "./services/logflare.service.ts";
import {
  legacyBuildVectorContainerSpec,
  legacyResolveDockerDaemonHost,
  legacyResolveVectorDockerSocketPlan,
} from "./services/vector.service.ts";
import {
  legacyBuildKongContainerSpec,
  legacyResolveKongNginxWorkerProcesses,
  type LegacyKongEmailTemplateMount,
} from "./services/kong.service.ts";
import {
  legacyStartEdgeRuntimeContainer,
  type LegacyEdgeRuntimeBringUpInput,
} from "./services/edge-runtime.service.ts";
import {
  buildLegacyGotrueContainerSpec,
  type LegacyBuildGotrueEnvInput,
  type LegacyGotrueExternalProviderInput,
} from "./services/gotrue.service.ts";
import { legacyBuildMailpitContainerSpec } from "./services/mailpit.service.ts";
import {
  legacyBuildRealtimeContainerSpec,
  LEGACY_REALTIME_TENANT_ID,
} from "./services/realtime.service.ts";
import { legacyBuildPostgrestContainerSpec } from "./services/postgrest.service.ts";
import { legacyBuildStorageContainerSpec } from "./services/storage.service.ts";
import { legacyBuildImgproxyContainerSpec } from "./services/imgproxy.service.ts";
import { legacyBuildPostgresStartContainerSpec } from "./services/postgres.service.ts";
import { buildLegacyPgMetaContainerSpec } from "./services/pg-meta.service.ts";
import { buildLegacyStudioContainerSpec } from "./services/studio.service.ts";
import { legacyBuildSupavisorContainerSpec } from "./services/supavisor.service.ts";

/**
 * `Config.Analytics.ApiKey`'s only possible value (`apps/cli-go/pkg/config/
 * config.go:307,529`) — `toml:"-"`, so never configurable. Duplicated locally
 * rather than hoisted: `logflare.service.ts`/`studio.service.ts` each already
 * hardcode this same Go compile-time literal independently, matching that
 * existing precedent instead of introducing a new shared constant for it.
 */
const LEGACY_ANALYTICS_API_KEY = "api-key";

const DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS = 30;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Docker's/Podman's "container doesn't exist" stderr shapes for `container inspect`. */
function isContainerNotFoundMessage(message: string): boolean {
  return /no such container/iu.test(message) || /no container with name or id/iu.test(message);
}

/** Same widening `values.analyticsBackend` already applies for analytics, but for `config.db.pooler.pool_mode`. */
function toPoolMode(value: string): "transaction" | "session" {
  return value === "session" ? "session" : "transaction";
}

/**
 * Go's `Db.HealthTimeout` (`internal/db/start/start.go:180`) — a duration
 * STRING (`"2m"` default, `packages/config/src/db.ts`), unlike every other
 * `start` health wait, which uses the fixed 30s `serviceTimeout` global
 * (`apps/cli-go/internal/start/start.go:161,1271`). Falls back to that same
 * 30s default on a malformed value rather than propagating a parse error —
 * this field has no `Config.Validate` format check on the Go side either.
 */
function resolveDbHealthTimeoutSeconds(healthTimeout: string): number {
  try {
    const seconds = Math.round(legacyParseGoDuration(healthTimeout) / 1_000_000_000);
    return seconds > 0 ? seconds : DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS;
  } catch {
    return DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS;
  }
}

/**
 * Go's `appendGotruePasskeyEnv`/`Auth.Passkey`/`Auth.Webauthn` presence gate
 * (`start.go:1427-1440`, `pkg/config/config.go:1117-1134`): `@supabase/config`
 * has no `auth.passkey`/`auth.webauthn` schema fields at all, so presence and
 * every field must come from the raw, pre-schema TOML document instead — same
 * document-based approach `legacy-local-config-values.ts` already uses for
 * these two sections.
 */
function resolveGotruePasskeyWebauthn(document: Readonly<Record<string, unknown>> | undefined): {
  readonly passkeyEnabled: boolean | undefined;
  readonly webauthn:
    | {
        readonly rpId: string;
        readonly rpDisplayName: string;
        readonly rpOrigins: ReadonlyArray<string>;
      }
    | undefined;
} {
  const authDoc = asRecord(document?.["auth"]);
  const passkeyDoc = asRecord(authDoc?.["passkey"]);
  const webauthnDoc = asRecord(authDoc?.["webauthn"]);
  const passkeyEnabled = passkeyDoc !== undefined ? passkeyDoc["enabled"] === true : undefined;
  const webauthn =
    webauthnDoc !== undefined
      ? {
          rpId: typeof webauthnDoc["rp_id"] === "string" ? webauthnDoc["rp_id"] : "",
          rpDisplayName:
            typeof webauthnDoc["rp_display_name"] === "string"
              ? webauthnDoc["rp_display_name"]
              : "",
          rpOrigins: Array.isArray(webauthnDoc["rp_origins"])
            ? webauthnDoc["rp_origins"].filter((item): item is string => typeof item === "string")
            : [],
        }
      : undefined;
  return { passkeyEnabled, webauthn };
}

/**
 * Go's `appendGotrueExternalProviderEnv` presence-filtering (`start.go:1442-
 * 1462`): Go's `Auth.External` is a genuine `map[string]provider{}` containing
 * only the providers a user's `config.toml` actually mentions, but
 * `@supabase/config`'s schema always decodes a fixed set of ~19 known
 * providers, each defaulting `enabled: false` regardless of TOML presence — so
 * presence must be read from the raw document, same approach already used by
 * `legacy-local-config-values.ts`'s `validateAuthExternalProviders`.
 */
function resolveGotrueExternalProviders(
  document: Readonly<Record<string, unknown>> | undefined,
  external: ProjectConfig["auth"]["external"],
): Record<string, LegacyGotrueExternalProviderInput> {
  const authDoc = asRecord(document?.["auth"]);
  const externalDoc = asRecord(authDoc?.["external"]);
  if (externalDoc === undefined) return {};

  const result: Record<string, LegacyGotrueExternalProviderInput> = {};
  const decodedProviders = new Map(Object.entries(external));
  // Iterate the RAW document's keys, not `Object.entries(external)` — Go's
  // `Auth.External` is a genuine `map[string]provider{}` iterated
  // unconditionally by `appendGotrueExternalProviderEnv`
  // (`apps/cli-go/internal/start/start.go:1442-1462`), but `@supabase/
  // config`'s `external` schema only decodes the ~19 known provider ids,
  // silently dropping any other name at decode time — so a custom
  // `[auth.external.my_oidc]` block would never reach GoTrue's env if this
  // only walked the decoded object. Same raw-document approach
  // `validateAuthExternalProviders` (`legacy-local-config-values.ts`) already
  // uses for the identical reason.
  for (const name of Object.keys(externalDoc)) {
    if (LEGACY_DEPRECATED_EXTERNAL_PROVIDERS.has(name)) continue;
    const provider = decodedProviders.get(name);
    if (provider !== undefined) {
      result[name] = {
        enabled: provider.enabled,
        clientId: provider.client_id,
        secret: provider.secret,
        url: provider.url,
        redirectUri: provider.redirect_uri,
        skipNonceCheck: provider.skip_nonce_check,
        emailOptional: provider.email_optional,
      };
      continue;
    }
    // Unmodeled/custom provider name — read the raw fields directly, same
    // defensive coercions `validateAuthExternalProviders` already uses.
    const rawProvider = asRecord(externalDoc[name]);
    if (rawProvider === undefined) continue;
    result[name] = {
      enabled: rawProvider["enabled"] === true,
      clientId: typeof rawProvider["client_id"] === "string" ? rawProvider["client_id"] : "",
      secret: typeof rawProvider["secret"] === "string" ? rawProvider["secret"] : undefined,
      url: typeof rawProvider["url"] === "string" ? rawProvider["url"] : "",
      redirectUri:
        typeof rawProvider["redirect_uri"] === "string" ? rawProvider["redirect_uri"] : undefined,
      skipNonceCheck: rawProvider["skip_nonce_check"] === true,
      emailOptional: rawProvider["email_optional"] === true,
    };
  }
  return result;
}

/**
 * Every value {@link buildLegacyGotrueContainerSpec} needs from `config`/
 * `values`, minus `dbHost`/`dbPassword` (which that builder derives itself
 * from `projectId`/`dbUrl`). See this module's header for the `@supabase/
 * config` schema gaps (`captcha`/`passkey`/`webauthn`/`email.smtp` presence,
 * `external` provider filtering) `gotrue.service.ts`'s own doc comment
 * documents — reused here.
 *
 * A configured `auth.signing_keys_path` is honored for anon/service_role JWT
 * SIGNING (`values.jwtSecret`/`legacyResolveLocalConfigValues`'s own
 * `loadFirstSigningKey`), for the stack-wide JWKS document
 * (`legacyResolveLocalJwks`), AND here as GoTrue's own `GOTRUE_JWT_KEYS` (Go's
 * `GOTRUE_JWT_KEYS = utils.Config.Auth.SigningKeys`, `start.go:640`) — all
 * three resolve the SAME file via {@link legacyResolveConfiguredSigningKeys},
 * so GoTrue always signs with (one of) the key(s) the published JWKS
 * advertises. `undefined` (Go's own default ES256 key, matching
 * `gotrue.service.ts`'s hardcoded `LEGACY_GOTRUE_DEFAULT_SIGNING_KEY`) only
 * when no `signing_keys_path` is configured or auth is disabled.
 */

/**
 * `auth.external_url` isn't modeled in `@supabase/config`'s schema, so it's
 * read off the raw document — same presence-based pattern as passkey/
 * webauthn/external. Go's `auth.GetExternalURL` (`pkg/config/auth.go:401-405`)
 * prefers this explicit value over deriving from `apiUrl`, and feeds it into
 * `API_EXTERNAL_URL`, the mailer verify URL, the default JWT issuer, and
 * OAuth redirect-URI fallbacks (`start.go:1354,1357,1374,1446`) for the
 * long-running GoTrue container — AND into the identical `API_EXTERNAL_URL`
 * Go's one-shot fresh-DB auth migration job builds (`db/start/start.go:323`).
 * Both callers must resolve the SAME value, hence this standalone helper
 * instead of two independent derivations.
 */
function resolveAuthExternalUrl(
  document: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const rawAuthExternalUrl = asRecord(document?.["auth"])?.["external_url"];
  return envOverride(
    "SUPABASE_AUTH_EXTERNAL_URL",
    typeof rawAuthExternalUrl === "string" ? rawAuthExternalUrl : undefined,
    projectEnvValues,
  );
}

function resolveGotrueEnvInput(params: {
  readonly context: LegacyLocalProjectContext;
  readonly values: LegacyLocalConfigValues;
  readonly workdir: string;
  readonly kongContainerName: string;
  readonly mailpitContainerName: string;
}): Omit<LegacyBuildGotrueEnvInput, "dbHost" | "dbPassword"> {
  const { context, values, workdir, kongContainerName, mailpitContainerName } = params;
  const { config, projectEnvValues, loaded } = context;
  const document = loaded?.document;

  const inbucketEnabled = legacyEnvOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  // Go's `[auth.email.smtp]` presence-based `enabled` default — reading the
  // schema-decoded `config.auth.email.smtp` here would always see `enabled:
  // false` when the key is merely absent from the TOML table (`@supabase/
  // config`'s decode-time default), silently falling back to Mailpit even
  // when a real SMTP server is configured. `legacyResolveAuthEmailSmtp`
  // resolves this correctly off the raw document, same as the passkey/
  // webauthn/external-provider reads below.
  const resolvedSmtp = legacyResolveAuthEmailSmtp(asRecord(document?.["auth"]), projectEnvValues);
  const smtp =
    resolvedSmtp?.enabled === true
      ? {
          host: resolvedSmtp.host,
          port: resolvedSmtp.port,
          user: resolvedSmtp.user,
          pass: resolvedSmtp.pass,
          adminEmail: resolvedSmtp.adminEmail,
          senderName: resolvedSmtp.senderName,
        }
      : undefined;
  const mailpit =
    smtp === undefined && inbucketEnabled
      ? {
          containerName: mailpitContainerName,
          adminEmail: config.local_smtp.admin_email,
          senderName: config.local_smtp.sender_name,
        }
      : undefined;

  const { passkeyEnabled, webauthn } = resolveGotruePasskeyWebauthn(document);
  const externalProviders = resolveGotrueExternalProviders(document, config.auth.external);
  const authExternalUrl = resolveAuthExternalUrl(document, projectEnvValues);

  return {
    apiUrl: values.apiUrl,
    authExternalUrl,
    jwtSecret: values.jwtSecret,
    jwtIssuer: values.authJwtIssuer,
    jwtExpiry: values.authJwtExpiry,
    siteUrl: values.authSiteUrl,
    additionalRedirectUrls: values.authAdditionalRedirectUrls,
    enableSignup: values.authEnableSignup,
    enableAnonymousSignIns: values.authEnableAnonymousSignIns,
    enableRefreshTokenRotation: values.authEnableRefreshTokenRotation,
    refreshTokenReuseInterval: values.authRefreshTokenReuseInterval,
    enableManualLinking: values.authEnableManualLinking,
    minimumPasswordLength: values.authMinimumPasswordLength,
    passwordRequirements: values.authPasswordRequirements,
    email: config.auth.email,
    kongContainerName,
    smtp,
    mailpit,
    sms: config.auth.sms,
    sessions: config.auth.sessions,
    mfa: config.auth.mfa,
    rateLimit: config.auth.rate_limit,
    web3: config.auth.web3,
    oauthServer: config.auth.oauth_server,
    hooks: {
      mfaVerificationAttempt: config.auth.hook.mfa_verification_attempt,
      passwordVerificationAttempt: config.auth.hook.password_verification_attempt,
      customAccessToken: config.auth.hook.custom_access_token,
      sendSms: config.auth.hook.send_sms,
      sendEmail: config.auth.hook.send_email,
      beforeUserCreated: config.auth.hook.before_user_created,
    },
    captcha: config.auth.captcha,
    passkeyEnabled,
    webauthn,
    externalProviders,
    signingKeys: legacyResolveConfiguredSigningKeys(config, workdir, projectEnvValues),
  };
}

/** Go's `mountEmailTemplates` call sites for Kong (`start.go:544-558`): every configured template, then every ENABLED notification, suffixed `_notification`. */
function buildKongEmailTemplateMounts(
  email: ProjectConfig["auth"]["email"],
): ReadonlyArray<LegacyKongEmailTemplateMount> {
  return [
    ...Object.entries(email.template).map(([id, template]) => ({
      id,
      contentPath: template.content_path,
    })),
    ...Object.entries(email.notification)
      .filter(([, notification]) => notification.enabled)
      .map(([id, notification]) => ({
        id: `${id}_notification`,
        contentPath: notification.content_path,
      })),
  ];
}

export const legacyStart = Effect.fn("legacy.start")(function* (flags: LegacyStartFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const analytics = yield* Analytics;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dbConnection = yield* LegacyDbConnection;
  const runtimeInfo = yield* RuntimeInfo;

  yield* Effect.gen(function* () {
    // 0. Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-250`) —
    // unconditional, before `start`'s own `RunE` (see step 1's citation).
    yield* legacyValidateWorkdirIsDirectory(cliConfig.workdir, fs).pipe(
      Effect.mapError((error) => new LegacyStartWorkdirError({ message: error.message })),
    );

    // 1. Go's `startCmd.RunE` calls `validateExcludedContainers` as its VERY
    // FIRST line (`cmd/start.go:49`) — before `start.Run` even loads config or
    // checks whether the stack is already running, so this warning fires
    // unconditionally on every invocation with an invalid `--exclude` value,
    // including the already-running short-circuit below. `excludedKeys` (the
    // VALID subset) is what actually gates container bring-up later.
    const partition = legacyPartitionStartExcludeFlags(flags.exclude);
    if (partition.warning !== undefined && output.format === "text") {
      yield* output.raw(partition.warning, "stderr");
    }
    const excludedKeys = new Set(partition.valid);

    // 2. Go's `flags.LoadConfig` (config load + `Validate`,
    // `internal/utils/flags/config_path.go:10-14` -> `pkg/config/config.go:882`)
    // — same config-load/env/project-id resolution sequence as `stop`/`status`.
    const context = yield* legacyLoadLocalProjectContext(
      cliConfig.workdir,
      (message) => new LegacyStartConfigLoadError({ message }),
    );
    const values = yield* Effect.try({
      try: () =>
        legacyResolveLocalConfigValues(
          context.config,
          context.hostname,
          cliConfig.workdir,
          context.projectEnvValues,
          context.loaded?.document,
        ),
      catch: (cause) =>
        new LegacyStartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const { config, projectId, projectEnvValues } = context;
    const dbContainerId = localDbContainerId(projectId);
    const filterValue = legacyCliProjectFilterValue(projectId);

    // Shared status-values helper — reused by BOTH the already-running branch
    // (full `status.Run` pipeline, health-checked + "stopped" diffed) and the
    // success path at the end (Go's direct `status.PrettyPrint`/`toValues`
    // call, no re-health-check — see each call site's own comment for why
    // they differ).
    const buildStatusValues = Effect.fnUntraced(function* (excluded: ReadonlyArray<string>) {
      const localState = yield* Effect.try({
        try: () =>
          legacyResolveStatusLocalState(
            context.config,
            context.hostname,
            cliConfig.workdir,
            context.projectEnvValues,
            context.loaded?.document,
          ),
        catch: (cause) =>
          new LegacyStatusInvalidConfigError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const containerIds = legacyStatusContainerIds(projectId);
      const state = legacyGateStatusState(localState, containerIds, excluded);
      return legacyStatusValuesFromState(state, new Map());
    });

    // 3. Go's `AssertSupabaseDbIsRunning` (`internal/utils/misc.go:144-146`) —
    // a bare `ContainerInspect` EXISTENCE check, true even for a merely
    // present-but-stopped container. "Not found" is the ONE outcome that means
    // "proceed to bring up the stack"; any OTHER inspect failure (e.g. the
    // Docker daemon itself being unreachable) must propagate and fail `start`
    // outright, matching Go's `!errors.Is(err, utils.ErrNotRunning)` branch.
    const alreadyRunning = yield* legacyInspectContainerState(spawner, dbContainerId).pipe(
      Effect.map(() => true),
      Effect.catch((error) =>
        isContainerNotFoundMessage(error.message) ? Effect.succeed(false) : Effect.fail(error),
      ),
    );

    if (alreadyRunning) {
      // `start.go:55`: printed unconditionally in Go (which has no JSON output
      // mode to protect); gated here on text mode for internal consistency
      // with every other supplementary stderr line this handler prints (see
      // the exclude warning above and the success-path messages below) — this
      // port's `--output-format json|stream-json` callers get a clean
      // structured payload with no extra text noise.
      if (output.format === "text") {
        yield* output.raw(legacyStartAlreadyRunningMessage(), "stderr");
      }

      // Mirrors Go's `status.Run` (`internal/status/status.go:99-123`), which
      // `start.go:57` delegates to for this branch — full health-check +
      // "stopped services" diffing pipeline, distinct from the success path's
      // direct `status.PrettyPrint` call below (see that branch's own
      // comment for why the two differ).
      if (!flags.ignoreHealthCheck) {
        const state = yield* legacyInspectContainerState(spawner, dbContainerId).pipe(
          Effect.mapError((cause) => new LegacyStatusDbInspectError({ message: cause.message })),
        );
        if (!state.running) {
          return yield* Effect.fail(
            new LegacyStatusDbNotRunningError({
              message: `${dbContainerId} container is not running: ${state.status}`,
            }),
          );
        }
        if (state.health !== undefined && state.health !== "healthy") {
          return yield* Effect.fail(
            new LegacyStatusDbNotReadyError({
              message: `${dbContainerId} container is not ready: ${state.health}`,
            }),
          );
        }
      }

      const runningNames = yield* legacyListContainersByLabel(spawner, {
        projectIdFilter: filterValue,
        all: false,
        format: "names",
      }).pipe(Effect.mapError((cause) => new LegacyStatusListError({ message: cause.message })));
      const runningSet = new Set(runningNames);
      const serviceIds = legacyServiceContainerIds(projectId);
      const stopped = serviceIds.filter((id) => !runningSet.has(id));
      // Unconditional in Go (`status.go:114`) and here — stderr text, never
      // corrupts a JSON stdout payload.
      if (stopped.length > 0) {
        yield* output.raw(`Stopped services: [${stopped.join(" ")}]\n`, "stderr");
      }
      const excluded = [...stopped, ...flags.exclude];

      if (output.format === "text") {
        // `status.go:118`'s pretty-branch banner -- distinct from (and printed
        // in ADDITION to) `legacyStartAlreadyRunningMessage()` above; Go
        // really does stack both lines in this branch.
        yield* output.raw(
          `${legacyAqua("supabase")} local development setup is running.\n\n`,
          "stderr",
        );
        const { values: statusValues, names } = yield* buildStatusValues(excluded);
        yield* output.raw(legacyRenderStatusPretty(statusValues, names));
      } else {
        const { values: statusValues } = yield* buildStatusValues(excluded);
        yield* output.success("", statusValues);
      }
      return;
    }

    // 4. Go's `flags.LoadProjectRef`/`services.CheckVersions` best-effort
    // update-suggestion (`start.go:61-63`): a Management API call gated on the
    // project being linked AND the user being logged in, purely to print an
    // "update available" hint, every error silently swallowed. Deliberately
    // NOT implemented — this command has zero Management API dependency by
    // design; omission confirmed against source, not missed.

    // 5. Gate evaluation — see `start.gates.ts` for the full boolean table.
    const gates = legacyResolveStartGates({ config, projectEnvValues, excludedKeys });

    // 6. Go's `utils.Config.Auth.ResolveJWKS(ctx)` (`start.go:274-277`) — runs
    // UNCONDITIONALLY, before any image pull, regardless of whether
    // auth/realtime/postgrest/storage end up enabled.
    const jwks = yield* Effect.tryPromise({
      try: () =>
        legacyResolveLocalJwks(config, cliConfig.workdir, values.jwtSecret, projectEnvValues),
      catch: (cause) =>
        new LegacyStartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // Go's `Config.Load` folds `SUPABASE_DB_MAJOR_VERSION` into
    // `c.Db.MajorVersion` before the image-selection switch runs
    // (`pkg/config/config.go:585-586,819-827`), and every later Go read of
    // `utils.Config.Db.MajorVersion` — image, version-pin gating, the
    // PG14/PG15+ branch, migration-job selection — sees that SAME
    // already-overridden value. `legacyResolveLocalConfigValues` already
    // computed/validated this exact value above; recomputing it here (rather
    // than threading it out of `values`) matches this file's own precedent
    // for the realtime/storage/auth `enabled` overrides a few dozen lines
    // below.
    const majorVersion = legacyEnvOverrideMajorVersion(config.db.major_version, projectEnvValues);
    // Same treatment as `majorVersion` above, for the sibling
    // `edge_runtime.deno_version` -> `Config.EdgeRuntime.Image` switch
    // (`pkg/config/config.go:1164-1173`), applied before `Validate` at the
    // end of `Config.Load` (`config.go:882`).
    const denoVersion = legacyEnvOverrideDenoVersion(
      config.edge_runtime.deno_version,
      projectEnvValues,
    );
    // Same generic-Viper-override gap as `majorVersion`/`denoVersion` above,
    // for `experimental.orioledb_version` -> `Config.Db.Image` rewrite
    // (`pkg/config/config.go:1041-1046`), applied at the end of `Config.Load`
    // (`config.go:882`) before `start` reads it. Also threaded into the
    // Postgres container spec below, since `postgres.service.ts`'s
    // `legacyPostgresExtraEnv` reads this same field to decide whether to add
    // the S3/`POSTGRES_INITDB_ARGS` env vars — both consumers must agree.
    const orioledbVersion = envOverride(
      "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
      config.experimental.orioledb_version,
      projectEnvValues,
    );

    // 7. Resolve every image that will actually be pulled (Go's
    // `ensureImagesCached`, `start.go:225-262,289`) BEFORE any container is
    // created.
    const postgresImage = yield* legacyResolveDbImage(
      fs,
      path,
      cliConfig.workdir,
      majorVersion,
      orioledbVersion,
    );
    // Go's `Config.Load` rewrites `c.Auth.Image`/`c.Api.Image`/etc. from
    // `supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,
    // pooler}-version` (linked-project pins written by `supabase link`)
    // BEFORE `start` ever reads them (`pkg/config/config.go:827-863`) — read
    // once, reused by both the image plan below and the fresh-DB one-shot
    // setup jobs' images, which Go resolves from the same already-rewritten
    // `utils.Config.*.Image` fields regardless of `--exclude`.
    const serviceVersionOverrides = yield* readLegacyServiceVersionOverrides(
      fs,
      path,
      cliConfig.workdir,
      majorVersion,
    );
    const imagePlan = legacyResolveStartImagePlan(gates, serviceVersionOverrides);
    // Edge Runtime doesn't go through `legacyResolveStartImagePlan` (see
    // `start.gates.ts`'s header) — its default image is resolved independently,
    // matching Go's own `pullImagesUsingCompose`/`ensureImagesCached` also
    // pre-pulling `utils.Config.EdgeRuntime.Image` whenever it's enabled and not
    // excluded.
    const edgeRuntimeDefaultImage = gates.edgeRuntime
      ? yield* legacyResolveEdgeRuntimeImage(fs, path, cliConfig.workdir, denoVersion)
      : undefined;
    const resolvedImages = yield* legacyEnsureImagesCached(
      spawner,
      [
        postgresImage,
        ...imagePlan.map((entry) => entry.image),
        ...(edgeRuntimeDefaultImage !== undefined ? [edgeRuntimeDefaultImage] : []),
      ],
      projectEnvValues,
    );
    const resolveImage = (image: string) => resolvedImages.get(image) ?? image;

    // Hoisted out of the Edge Runtime bring-up below: Go's Studio bring-up
    // (`start.go:1149-1159`) calls `serve.PopulatePerFunctionConfigs` for its
    // own bind mounts UNCONDITIONALLY of `Config.EdgeRuntime.Enabled`, so
    // these manifest values must be available to `buildSpecForService`'s
    // "studio" case regardless of whether Edge Runtime itself is enabled.
    const configDeclaredFunctions = toPlainFunctionRecord(config.functions);
    const configFunctions = yield* inferFunctionsManifest({
      cwd: cliConfig.workdir,
      config: { ...config, functions: configDeclaredFunctions },
    });
    const rawConfigFunctions = rawFunctionConfigRecord(context.loaded?.document);

    // Go's `config.Load` reads `supabase/.temp/storage-migration` (written by
    // `supabase link`) into `Config.Storage.TargetMigration` whenever present
    // (`pkg/config/config.go:844-846`), and that value feeds
    // `DB_MIGRATIONS_FREEZE_AT` for both the Storage container and the
    // fresh-DB one-shot Storage migrate job. Any read error (including
    // not-exist) or blank content resolves to "", matching Go's `err == nil
    // && len(version) > 0` gate.
    const storageTargetMigration = yield* fs
      .readFileString(legacyTempPaths(path, cliConfig.workdir).storageMigration)
      .pipe(
        Effect.map((content) => content.trim()),
        Effect.orElseSucceed(() => ""),
      );

    // Go's `DockerStart` forces every container's network mode (and the
    // network it creates) to `--network-id` when set, ahead of the generated
    // `supabase_network_<project>` fallback (`docker.go:379-383`).
    const networkIdFlag = yield* LegacyNetworkIdFlag;
    const networkId = Option.isSome(networkIdFlag)
      ? networkIdFlag.value
      : localNetworkId(projectId);
    const isBitbucketPipeline = legacyIsBitbucketPipeline();
    // Go's `DockerStart` unconditionally appends the Linux-only
    // `host.docker.internal:host-gateway` extra host for every container it
    // starts (`docker_linux.go`; empty on darwin/windows, where Docker
    // Desktop already resolves that hostname) — same expression already used
    // for the one-shot migrate jobs (`db-setup.ts`) and Edge Runtime bring-up
    // (`legacy-edge-runtime-script.layer.ts`).
    const extraHosts =
      runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
    const startOpts: LegacyStartContainerOpts = {
      projectId,
      isBitbucketPipeline,
      workdir: cliConfig.workdir,
      extraHosts,
    };
    const dbHost = dbContainerId;
    const dbPassword = legacyStartInternalDbPassword(values.dbUrl);

    const kongContainerName = legacyServiceContainerName("kong", projectId);
    const gotrueContainerName = legacyServiceContainerName("auth", projectId);
    const restContainerName = legacyServiceContainerName("rest", projectId);
    const realtimeContainerName = legacyServiceContainerName("realtime", projectId);
    const storageContainerName = legacyServiceContainerName("storage", projectId);
    const studioContainerName = legacyServiceContainerName("studio", projectId);
    const pgMetaContainerName = legacyServiceContainerName("pg_meta", projectId);
    const edgeRuntimeContainerName = legacyServiceContainerName("edge_runtime", projectId);
    const logflareContainerName = legacyServiceContainerName("analytics", projectId);
    const poolerContainerName = legacyServiceContainerName("pooler", projectId);
    const vectorContainerName = legacyServiceContainerName("vector", projectId);
    const mailpitContainerName = legacyServiceContainerName("inbucket", projectId);

    // Hoisted out of the "kong" case below (it used to be computed only
    // there): the post-bring-up health-probe CA-trust lookup near the end of
    // this function needs the SAME env-overridden value, not the raw
    // `config.api.tls.enabled` — Go has one source of truth here (`Config.
    // Load` applies `SUPABASE_API_TLS_ENABLED` before `Validate` populates
    // `Api.Tls.CertContent`, `pkg/config/config.go:586,749,882,1006-1019`),
    // and `status.NewKongClient`'s trust pool + its health probe's target URL
    // both read that same already-overridden global (`internal/status/
    // status.go:181-229`).
    const apiTlsEnabled = legacyEnvOverrideBool(
      "SUPABASE_API_TLS_ENABLED",
      config.api.tls.enabled,
      "api.tls.enabled",
      projectEnvValues,
    );

    // Same generic-Viper-override gap as `apiTlsEnabled` above, for Realtime's
    // two `SUPABASE_REALTIME_*` fields — both the Realtime container spec
    // below AND the PG15+ Realtime setup job (`legacyStartSetupLocalDatabase`,
    // via the `realtime` splice further down) must see the SAME
    // already-overridden values, matching Go's single `utils.Config.Realtime`
    // source of truth (`internal/start/start.go:922,928`,
    // `internal/db/start/start.go:283,290`).
    const realtimeIpVersion = legacyEnvOverrideRealtimeIpVersion(
      config.realtime.ip_version,
      projectEnvValues,
    );
    const realtimeMaxHeaderLength = legacyEnvOverrideRealtimeMaxHeaderLength(
      config.realtime.max_header_length,
      projectEnvValues,
    );

    // Same gap for Storage's file-size limit — both the long-running
    // container below AND the one-shot storage migrate job
    // (`legacyStartSetupLocalDatabase`, via the `storage` splice further
    // down) must see the same already-overridden value (Go's
    // `internal/start/start.go:1004`, `internal/db/start/start.go:307`, both
    // reading the single `utils.Config.Storage.FileSizeLimit`).
    const storageFileSizeLimit =
      envOverride(
        "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
        config.storage.file_size_limit,
        projectEnvValues,
      ) ?? config.storage.file_size_limit;

    /**
     * Every case returns `{ spec, excludeFromHealthWatch? }`: `spec` is the
     * {@link LegacyStartContainerSpec} to bring up; `excludeFromHealthWatch`
     * (only ever set by "vector") is returned explicitly instead of a captured
     * mutable variable — Go's Vector `parsed.Scheme != "npipe"` exception
     * (`start.go:481`) is the only case that ever sets it.
     */
    const buildSpecForService = Effect.fnUntraced(function* (service: string, image: string) {
      switch (service) {
        case "logflare":
          return {
            spec: legacyBuildLogflareContainerSpec({
              image,
              projectId,
              networkId,
              port: config.analytics.port,
              backend: values.analyticsBackend,
              gcpProjectId: values.gcpProjectId,
              gcpProjectNumber: values.gcpProjectNumber,
              gcpJwtPath: values.gcpJwtPath,
              workdir: cliConfig.workdir,
              dbHost,
              dbPort: LEGACY_START_INTERNAL_DB_PORT,
              dbUser: "postgres",
              dbPassword,
            }),
          };

        case "vector": {
          const daemonHost = yield* legacyResolveDockerDaemonHost(spawner);
          const dockerSocketPlan = legacyResolveVectorDockerSocketPlan(daemonHost);
          // Go's Windows-only warning (`start.go:428-429`) — gated on text
          // mode for the same reason as every other supplementary line here.
          if (dockerSocketPlan.isNpipe && output.format === "text") {
            yield* output.raw(
              `${legacyYellow("WARNING:")} Analytics on Windows requires Docker daemon exposed on tcp://localhost:2375.\n` +
                "See https://supabase.com/docs/guides/local-development/cli/getting-started?queryGroups=platform&platform=windows#running-supabase-locally for more details.\n",
              "stderr",
            );
          }
          return {
            spec: legacyBuildVectorContainerSpec({
              image,
              containerName: vectorContainerName,
              networkId,
              apiKey: LEGACY_ANALYTICS_API_KEY,
              logflareId: logflareContainerName,
              kongId: kongContainerName,
              gotrueId: gotrueContainerName,
              restId: restContainerName,
              realtimeId: realtimeContainerName,
              storageId: storageContainerName,
              edgeRuntimeId: edgeRuntimeContainerName,
              dbId: dbContainerId,
              dockerSocketPlan,
            }),
            // Go's Vector `parsed.Scheme != "npipe"` exception (`start.go:481`):
            // still created/started, just never added to the health-wait watch list.
            excludeFromHealthWatch: dockerSocketPlan.isNpipe,
          };
        }

        case "kong": {
          // Go's `NewConfig` seeds `Api.Tls.{CertContent,KeyContent}`
          // unconditionally from the embedded default cert/key
          // (`pkg/config/config.go:452-455`); `Validate` only overwrites them
          // from disk when TLS is enabled AND both `cert_path`/`key_path` are
          // set (`config.go:1010-1027`). So a `[api.tls] enabled = true`
          // project with no custom paths still gets a real cert/key here —
          // never empty strings — matching Kong's own unconditional write of
          // these fields to `/home/kong/localhost.{crt,key}` (`start.go:585-601`).
          let tlsCertContent: string = LEGACY_KONG_LOCAL_TLS_CERT;
          let tlsKeyContent: string = LEGACY_KONG_LOCAL_TLS_KEY;
          if (
            apiTlsEnabled &&
            config.api.tls.cert_path !== undefined &&
            config.api.tls.key_path !== undefined
          ) {
            tlsCertContent = yield* fs
              .readFileString(legacyResolveApiTlsPath(cliConfig.workdir, config.api.tls.cert_path))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new LegacyStartInvalidConfigError({
                      message: `failed to read api tls cert: ${String(cause)}`,
                    }),
                ),
              );
            tlsKeyContent = yield* fs
              .readFileString(legacyResolveApiTlsPath(cliConfig.workdir, config.api.tls.key_path))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new LegacyStartInvalidConfigError({
                      message: `failed to read api tls key: ${String(cause)}`,
                    }),
                ),
              );
          }
          return {
            spec: legacyBuildKongContainerSpec({
              image,
              containerName: kongContainerName,
              networkId,
              apiHost: context.hostname,
              apiPort: values.apiPort,
              apiTlsEnabled,
              tlsCertContent,
              tlsKeyContent,
              apiKeys: {
                secretKey: values.secretKey,
                serviceRoleKey: values.serviceRoleKey,
                publishableKey: values.publishableKey,
                anonKey: values.anonKey,
              },
              gotrueId: gotrueContainerName,
              restId: restContainerName,
              realtimeTenantId: LEGACY_REALTIME_TENANT_ID,
              storageId: storageContainerName,
              studioId: studioContainerName,
              pgmetaId: pgMetaContainerName,
              edgeRuntimeId: edgeRuntimeContainerName,
              logflareId: logflareContainerName,
              poolerId: poolerContainerName,
              nginxWorkerProcesses: legacyResolveKongNginxWorkerProcesses(projectEnvValues),
              workdir: cliConfig.workdir,
              emailTemplateMounts: buildKongEmailTemplateMounts(config.auth.email),
            }),
          };
        }

        case "gotrue":
          return {
            spec: buildLegacyGotrueContainerSpec({
              image,
              projectId,
              networkId,
              dbUrl: values.dbUrl,
              env: resolveGotrueEnvInput({
                context,
                values,
                workdir: cliConfig.workdir,
                kongContainerName,
                mailpitContainerName,
              }),
            }),
          };

        case "mailpit":
          return {
            spec: legacyBuildMailpitContainerSpec({
              image,
              projectId,
              networkId,
              port: config.local_smtp.port,
              smtpPort: config.local_smtp.smtp_port,
              pop3Port: config.local_smtp.pop3_port,
            }),
          };

        case "realtime":
          return {
            spec: legacyBuildRealtimeContainerSpec({
              projectId,
              networkId,
              image,
              ipVersion: realtimeIpVersion,
              maxHeaderLength: realtimeMaxHeaderLength,
              dbUrl: values.dbUrl,
              jwtSecret: values.jwtSecret,
              jwks,
            }),
          };

        case "postgrest":
          return {
            spec: legacyBuildPostgrestContainerSpec({
              projectId,
              networkId,
              image,
              schemas: config.api.schemas,
              extraSearchPath: config.api.extra_search_path,
              maxRows: config.api.max_rows,
              dbUrl: values.dbUrl,
              jwks,
            }),
          };

        case "storage":
          return {
            spec: legacyBuildStorageContainerSpec({
              projectId,
              networkId,
              image,
              targetMigration: storageTargetMigration,
              fileSizeLimit: storageFileSizeLimit,
              s3Region: values.storageS3Region,
              s3AccessKeyId: values.storageS3AccessKeyId,
              s3SecretAccessKey: values.storageS3SecretAccessKey,
              s3ProtocolEnabled: legacyEnvOverrideBool(
                "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
                config.storage.s3_protocol.enabled,
                "storage.s3_protocol.enabled",
                projectEnvValues,
              ),
              imageTransformationEnabled: gates.imgproxy,
              vectorBucketsEnabled: legacyEnvOverrideBool(
                "SUPABASE_STORAGE_VECTOR_ENABLED",
                config.storage.vector.enabled,
                "storage.vector.enabled",
                projectEnvValues,
              ),
              dbUrl: values.dbUrl,
              jwtSecret: values.jwtSecret,
              jwks,
              anonKey: values.anonKey,
              serviceRoleKey: values.serviceRoleKey,
              projectEnvValues,
            }),
          };

        case "imgproxy":
          return { spec: legacyBuildImgproxyContainerSpec({ projectId, networkId, image }) };

        case "pgMeta":
          return {
            spec: buildLegacyPgMetaContainerSpec({
              image,
              containerName: pgMetaContainerName,
              dbHost,
              dbPort: LEGACY_START_INTERNAL_DB_PORT,
              dbUser: "postgres",
              dbPassword,
              dbName: LEGACY_START_INTERNAL_DB_NAME,
              networkId,
            }),
          };

        case "studio": {
          // Go's `start.go:1149-1159` computes Studio's function bind mounts
          // via `serve.PopulatePerFunctionConfigs` unconditionally whenever
          // Studio is enabled — NOT gated on `Config.EdgeRuntime.Enabled` —
          // so function sources/import maps/static assets stay mounted for
          // Studio's local function management even when Edge Runtime itself
          // is disabled or excluded.
          const functionBinds = yield* resolveFunctionBindMounts(
            projectId,
            cliConfig.workdir,
            `${cliConfig.workdir}/supabase`,
            { configDeclaredFunctions, configFunctions, rawConfigFunctions },
            Option.none(),
            Option.none(),
            cliConfig.workdir,
          );
          return {
            spec: buildLegacyStudioContainerSpec({
              image,
              containerName: studioContainerName,
              networkId,
              port: config.studio.port,
              functionBinds: [...functionBinds],
              env: {
                dbPassword,
                workdir: cliConfig.workdir,
                cliVersion: CLI_VERSION,
                pgMetaContainerName,
                kongContainerName,
                logflareContainerName,
                studioApiUrl: legacyResolveStudioApiUrl(
                  envOverride("SUPABASE_STUDIO_API_URL", config.studio.api_url, projectEnvValues) ??
                    config.studio.api_url,
                  context.hostname,
                  values.apiUrl,
                ),
                jwtSecret: values.jwtSecret,
                anonKey: values.anonKey,
                serviceRoleKey: values.serviceRoleKey,
                publishableKey: values.publishableKey,
                secretKey: values.secretKey,
                s3AccessKeyId: values.storageS3AccessKeyId,
                s3SecretAccessKey: values.storageS3SecretAccessKey,
                openaiApiKey: values.openaiApiKey,
                apiSchemas: config.api.schemas,
                apiExtraSearchPath: config.api.extra_search_path,
                apiMaxRows: config.api.max_rows,
                analyticsEnabled: values.analyticsEnabled,
                analyticsBackend: values.analyticsBackend,
              },
            }),
          };
        }

        case "supavisor":
          return {
            spec: legacyBuildSupavisorContainerSpec({
              image,
              projectId,
              networkId,
              port: config.db.pooler.port,
              poolMode: toPoolMode(config.db.pooler.pool_mode),
              defaultPoolSize: config.db.pooler.default_pool_size,
              maxClientConn: config.db.pooler.max_client_conn,
              jwtSecret: values.jwtSecret,
              dbHost,
              dbPort: LEGACY_START_INTERNAL_DB_PORT,
              dbUser: "postgres",
              dbPassword,
              dbDatabase: LEGACY_START_INTERNAL_DB_NAME,
            }),
          };

        default:
          return yield* Effect.die(`legacyStart: unrecognized service "${service}"`);
      }
    });

    // Go's real, package-level `utils.NoBackupVolume` global (`docker.go:94`):
    // set once, inside `StartDatabase`'s pre-create volume-existence check
    // (`internal/db/start/start.go:165-167`), then read much later by
    // `DockerRemoveAll` on a rollback (`docker.go:126`). A plain outer `let`
    // is this port's equivalent of that mutable global — unlike
    // `excludeFromHealthWatch` (returned explicitly from `buildSpecForService`
    // because a clean return-value alternative existed there), `isFreshVolume`
    // must survive PAST `bringUp`'s own failure path (`Effect.tapError` below,
    // which runs on ANY failure and has no access to a value `bringUp` only
    // returns on success) — there is no non-mutable way to thread a value
    // computed mid-effect into a sibling failure handler.
    let isFreshVolume = false;

    // 8. Bring-up: network -> Postgres (+ its own health wait, no
    // `--ignore-health-check` leniency, `start.go:294-298` ->
    // `db/start/start.go:180`) -> the fresh-volume-gated `SetupLocalDatabase`
    // equivalent (`db/start/start.go:184-188`, BEFORE any other service starts)
    // -> the 12 remaining enabled+non-excluded services plus Edge Runtime, in
    // Go's real start order (`start.gates.ts`'s `imagePlan` + `edgeRuntime`).
    // ANY failure in this whole phase rolls back and fails the command
    // outright (Go's per-block `if err != nil { return err }`, propagated to
    // `Run`'s rollback branch, `start.go:73-81`).
    const bringUp = Effect.gen(function* () {
      yield* legacyEnsureStartNetwork(spawner, networkId, {
        [LEGACY_CLI_PROJECT_LABEL]: projectId,
      });

      // Go's pre-create volume-existence check (`internal/db/start/start.go:
      // 165-167`) — MUST run before Postgres's own volume gets created by
      // `legacyStartContainer` below: `docker volume create` is idempotent, so
      // creating first would make "did this volume already exist" unobservable.
      isFreshVolume = !(yield* legacyStartVolumeExists(spawner, dbContainerId));
      if (output.format === "text") {
        yield* output.raw(
          isFreshVolume
            ? LEGACY_START_STARTING_DATABASE_MESSAGE
            : LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
          "stderr",
        );
      }

      const postgresSpec = legacyBuildPostgresStartContainerSpec({
        // `port` overridden by SUPABASE_DB_PORT (Go's NewHostConfig binds the
        // published port straight from the already-overridden
        // utils.Config.Db.Port, apps/cli-go/internal/db/start/start.go:119-121).
        // `settings` overridden by any `SUPABASE_DB_SETTINGS_*` field (Go's
        // `(a *settings) ToPostgresConfig()` serializes the same
        // already-overridden global `Config.Db.Settings`, `pkg/config/db.go:181-190`).
        db: {
          ...config.db,
          port: values.dbPort,
          major_version: majorVersion,
          settings: legacyResolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues),
        },
        // `orioledb_version` overridden by SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION,
        // matching the value already used to select `postgresImage` above —
        // `legacyPostgresExtraEnv` reads this same field for its S3/
        // `POSTGRES_INITDB_ARGS` branch.
        experimental: { ...config.experimental, orioledb_version: orioledbVersion },
        jwtSecret: values.jwtSecret,
        jwtExpiry: config.auth.jwt_expiry,
        projectId,
        networkId,
        image: resolveImage(postgresImage),
        configImage: postgresImage,
        rootKey: values.rootKey,
      });
      const postgresContainerId = yield* legacyStartContainer(spawner, postgresSpec, startOpts);
      yield* legacyWaitForHealthyServices(spawner, [postgresContainerId], {
        timeoutSeconds: resolveDbHealthTimeoutSeconds(config.db.health_timeout),
      });

      // Go's `if utils.NoBackupVolume { SetupLocalDatabase(...) }` (`db/start/
      // start.go:184-188`) — runs immediately after Postgres's OWN health wait,
      // BEFORE "Starting containers..." prints and before any other service
      // starts: `internal/start/start.go:293-298` calls `StartDatabase` (which
      // performs this whole sequence internally) before any other service's own
      // `if` block even runs.
      if (isFreshVolume) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* dbConnection.connect(
              {
                host: context.hostname,
                port: values.dbPort,
                user: "postgres",
                password: dbPassword,
                database: "postgres",
              },
              { isLocal: true, dnsResolver: "native" },
            );
            // Go's one-shot fresh-DB setup jobs (`initSchema15`) use the SAME
            // already-pin-rewritten `utils.Config.{Realtime,Storage,Auth}.Image`
            // fields the long-running containers use (`internal/db/start/
            // start.go:270,299,321`), regardless of `--exclude` — resolve
            // through `legacyResolvePinnedImage` (not the raw Dockerfile
            // default) so a linked project's version pins apply here too.
            const dbSetupImages: LegacyStartDbSetupImages = {
              realtime: resolveImage(
                legacyResolvePinnedImage("realtime", "realtime", serviceVersionOverrides),
              ),
              storage: resolveImage(
                legacyResolvePinnedImage("storage", "storage", serviceVersionOverrides),
              ),
              auth: resolveImage(
                legacyResolvePinnedImage("gotrue", "auth", serviceVersionOverrides),
              ),
            };
            yield* legacyStartSetupLocalDatabase({
              session,
              fs,
              path,
              workdir: cliConfig.workdir,
              // Go's `initSchema15`'s per-job gates read `utils.Config.
              // {Realtime,Storage,Auth}.Enabled` — the EFFECTIVE, env-overridden
              // value (Viper's `AutomaticEnv` already folds any `SUPABASE_*_
              // ENABLED` override into the single global `Config`), NOT
              // additionally filtered by `--exclude` the way `gates.*` is (Go's
              // one-shot migration jobs run regardless of `--exclude` — they're
              // part of `StartDatabase`, which finishes before `run()`'s own
              // excluded-services filtering even begins). `legacyResolveStartGates`
              // only exposes the exclude-combined booleans, so these three are
              // recomputed here, matching `resolveGotrueEnvInput`'s own precedent
              // of independently recomputing an env-overridden boolean rather than
              // threading it through.
              config: {
                ...config,
                realtime: {
                  ...config.realtime,
                  enabled: legacyEnvOverrideBool(
                    "SUPABASE_REALTIME_ENABLED",
                    config.realtime.enabled,
                    "realtime.enabled",
                    projectEnvValues,
                  ),
                  ip_version: realtimeIpVersion,
                  max_header_length: realtimeMaxHeaderLength,
                },
                storage: {
                  ...config.storage,
                  enabled: legacyEnvOverrideBool(
                    "SUPABASE_STORAGE_ENABLED",
                    config.storage.enabled,
                    "storage.enabled",
                    projectEnvValues,
                  ),
                  file_size_limit: storageFileSizeLimit,
                },
                auth: {
                  ...config.auth,
                  enabled: legacyEnvOverrideBool(
                    "SUPABASE_AUTH_ENABLED",
                    config.auth.enabled,
                    "auth.enabled",
                    projectEnvValues,
                  ),
                },
              },
              majorVersion,
              projectId,
              networkId,
              dbUrl: values.dbUrl,
              jwtSecret: values.jwtSecret,
              jwks,
              apiUrl: values.apiUrl,
              authExternalUrl: resolveAuthExternalUrl(context.loaded?.document, projectEnvValues),
              anonKey: values.anonKey,
              serviceRoleKey: values.serviceRoleKey,
              storageTargetMigration,
              images: dbSetupImages,
            });
          }),
        );
      }

      // Go's `initCurrentBranch` (`db/start/start.go:189`) runs on every start
      // regardless of `isFreshVolume` — unlike `SetupLocalDatabase`, which only
      // runs on a fresh volume. Moved out of `legacyStartSetupLocalDatabase` (see
      // that module's own comment) so it isn't accidentally skipped on a restart.
      yield* legacyStartInitCurrentBranch(fs, path, cliConfig.workdir);

      if (output.format === "text") {
        yield* output.raw(LEGACY_START_STARTING_CONTAINERS_MESSAGE, "stderr");
      }

      const started: Array<string> = [];
      let postgrestGateway: LegacyHealthCheckPostgrestGateway | undefined;
      let edgeRuntimeGateway: LegacyHealthCheckPostgrestGateway | undefined;
      let storageContainerId: string | undefined;
      const imagePlanByService = new Map(imagePlan.map((entry) => [entry.service, entry.image]));
      for (const entry of LEGACY_START_SERVICES) {
        if (entry.service === "postgres") continue;

        // Edge Runtime doesn't go through `imagePlan`/`buildSpecForService` —
        // see `start.gates.ts`'s header — so it's special-cased here, in Go's
        // real relative position (between ImgProxy and pg-meta).
        if (entry.service === "edgeRuntime") {
          if (!gates.edgeRuntime || edgeRuntimeDefaultImage === undefined) continue;
          const debug = yield* LegacyDebugFlag;
          const edgeRuntimeInput: LegacyEdgeRuntimeBringUpInput = {
            projectId,
            networkId,
            image: resolveImage(edgeRuntimeDefaultImage),
            workdir: cliConfig.workdir,
            dbUrl: values.dbUrl,
            apiPort: values.apiPort,
            edgeRuntimePolicy: config.edge_runtime.policy,
            edgeRuntimeInspectorPort: config.edge_runtime.inspector_port,
            edgeRuntimeSecrets: toPlainEdgeRuntimeConfig(config.edge_runtime).secrets,
            configDeclaredFunctions,
            configFunctions,
            rawConfigFunctions,
            authArtifacts: {
              publishableKey: values.publishableKey,
              secretKey: values.secretKey,
              jwtSecret: values.jwtSecret,
              anonKey: values.anonKey,
              serviceRoleKey: values.serviceRoleKey,
              jwks,
            },
            debug,
            platform: runtimeInfo.platform,
          };
          const runtime: StartedRuntime = yield* legacyStartEdgeRuntimeContainer(edgeRuntimeInput);
          // Deliberately NOT calling `runtime.cleanup` here — see
          // `edge-runtime.service.ts`'s header for why. `start`'s container is
          // `restartPolicy: "unless-stopped"` (mirroring every other service
          // built here, see `legacyStartContainer`), so its bind-mounted host
          // temp files must still exist whenever Docker re-attaches them on a
          // later restart; `legacyStartEdgeRuntimeContainer` already runs
          // `cleanup` on a failed or interrupted bring-up internally, so only
          // the success path must leave it alone.
          started.push(runtime.containerId);
          edgeRuntimeGateway = {
            containerId: runtime.containerId,
            apiExternalUrl: values.apiUrl,
            secretKey: values.secretKey,
          };
          continue;
        }

        const image = imagePlanByService.get(entry.service);
        if (image === undefined) continue;

        // Several service builders (e.g. GoTrue's `auth.email/sms.max_frequency` Go-duration
        // parsing, Storage's file-size-limit parsing) do synchronous, throwing work over
        // config.toml string fields `@supabase/config`'s schema does not itself validate as
        // durations/sizes. A malformed value would otherwise surface as an uncaught Effect
        // defect (`Effect.tapError` below only intercepts typed failures, never defects) —
        // silently skipping rollback and leaking every container/volume/network already
        // created this run. `catchDefect` converts any such throw into the same typed config
        // error every other malformed-config path in this handler already produces, so it
        // rolls back like any other bring-up failure, matching Go's fail-at-config-decode
        // behavior (Go's `time.Duration`/size fields fail at TOML decode, before any Docker
        // work starts).
        const { spec, excludeFromHealthWatch } = yield* buildSpecForService(
          entry.service,
          resolveImage(image),
        ).pipe(
          Effect.catchDefect((defect) =>
            Effect.fail(
              new LegacyStartInvalidConfigError({
                message: `invalid config for ${entry.service}: ${defect instanceof Error ? defect.message : String(defect)}`,
              }),
            ),
          ),
        );
        const containerId = yield* legacyStartContainer(spawner, spec, startOpts);
        if (excludeFromHealthWatch !== true) {
          started.push(containerId);
        }
        if (entry.service === "postgrest") {
          postgrestGateway = {
            containerId,
            apiExternalUrl: values.apiUrl,
            secretKey: values.secretKey,
          };
        }
        if (entry.service === "storage") {
          storageContainerId = containerId;
        }
      }

      return { started, postgrestGateway, edgeRuntimeGateway, storageContainerId };
    }).pipe(
      // Go's `DockerRemoveAll`'s real `utils.NoBackupVolume` value
      // (`docker.go:94,126`) — `true` only when this run's Postgres volume was
      // freshly created (see `isFreshVolume` above), matching Go exactly: a
      // rollback prunes volumes on a brand-new, empty first-ever `start`, but
      // never touches a pre-existing user's data on a failed restart.
      Effect.tapError(() => legacyRollbackStart(spawner, filterValue, isFreshVolume)),
    );

    const { started, postgrestGateway, edgeRuntimeGateway, storageContainerId } = yield* bringUp;

    // 9. Bulk health check over every non-Postgres started container, at the
    // generic 30s `serviceTimeout` (`start.go:161,1270-1271`).
    if (output.format === "text") {
      yield* output.raw(LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE, "stderr");
    }
    // The PostgREST/Edge Runtime readiness probes go through Kong over HTTP(S) —
    // when `api.tls.enabled`, Kong's local cert is self-signed, so the root
    // runtime's `HttpClient.HttpClient` (built from `FetchHttpClient.layer` over
    // plain `fetch`) would fail TLS verification on every probe and the health
    // check would exhaust its full timeout even though the services are
    // actually healthy. Resolve the same local Kong CA `legacySeedBucketsRun`'s
    // own gateway calls already trust (`projectRef: ""` never touches the
    // network — see `legacyResolveStorageCredentials`'s local branch) and
    // override just the underlying `FetchHttpClient.Fetch` primitive — NOT the
    // whole `HttpClient.HttpClient` layer — so this only takes effect for a
    // `FetchHttpClient`-backed client (production) and is a no-op against a
    // hand-rolled `HttpClient.make(...)` mock (this file's own integration
    // tests), which never reads `FetchHttpClient.Fetch` at all.
    //
    // Passes the hoisted, env-overridden `apiTlsEnabled` (not the raw
    // `config`) so a `SUPABASE_API_TLS_ENABLED=true` override that brought
    // Kong up on TLS also gets its CA trusted here — otherwise this lookup's
    // `resolveLocalBaseUrl` derives `http://` from the un-overridden
    // `config.api.tls.enabled`, `localKongCa` stays `undefined`, and the
    // probe above fails TLS verification against Kong's self-signed cert.
    const { localKongCa } = yield* legacyResolveStorageCredentials({
      projectRef: "",
      config: {
        ...config,
        api: { ...config.api, tls: { ...config.api.tls, enabled: apiTlsEnabled } },
      },
    });
    const healthResult = yield* legacyWaitForHealthyServices(spawner, started, {
      postgrest: postgrestGateway,
      edgeRuntime: edgeRuntimeGateway,
    }).pipe(
      Effect.result,
      localKongCa !== undefined
        ? Effect.provideService(FetchHttpClient.Fetch, legacyStorageGatewayFetch(localKongCa))
        : (effect) => effect,
    );
    if (Result.isFailure(healthResult)) {
      const error = healthResult.failure;
      if (flags.ignoreHealthCheck && legacyIsUnhealthyStartError(error)) {
        // `ignoreHealthCheck`/`IsUnhealthyError` only gates THIS wait
        // (`start.go:1271`), not Postgres's own earlier one. Go additionally
        // runs a narrower, storage-only recheck-and-seed here (`start.go:
        // 1272-1277`): when it's a fresh volume and Storage was among the
        // started containers, wait for Storage alone to become healthy, and
        // if it does, seed buckets. A seed FAILURE there REPLACES this
        // original health error and hard-fails (with rollback) — Go's
        // `return seedErr` — since a plain seed error never satisfies
        // `IsUnhealthyError` and so never gets this branch's own
        // downgrade-to-warning treatment. A seed SUCCESS (or a storage
        // recheck that never turns healthy) changes nothing: fall through to
        // the same downgrade-to-warning as every other ignored-unhealthy
        // failure.
        if (isFreshVolume && storageContainerId !== undefined) {
          const storageHealthResult = yield* legacyWaitForHealthyServices(spawner, [
            storageContainerId,
          ]).pipe(Effect.result);
          if (Result.isSuccess(storageHealthResult)) {
            const seedResult = yield* legacySeedBucketsRun({
              projectRef: "",
              emitSummary: false,
              interactive: false,
              yes: true,
            }).pipe(Effect.result);
            if (Result.isFailure(seedResult)) {
              yield* legacyRollbackStart(spawner, filterValue, isFreshVolume);
              return yield* Effect.fail(seedResult.failure);
            }
          }
        }
        // Downgrade to a warning and fall through to the success path, no rollback.
        yield* output.raw(`${error.message}\n`, "stderr");
      } else {
        yield* legacyRollbackStart(spawner, filterValue, isFreshVolume);
        return yield* Effect.fail(error);
      }
    }

    // 10. Go's `buckets.Run(...)` storage-bucket seeding (`start.go:1281-
    // 1286`), gated on `utils.NoBackupVolume && slices.Contains(started,
    // utils.StorageId)` — only when the Postgres data volume was freshly
    // created this run AND Storage actually started. Reached only on a
    // genuine health-check SUCCESS (`Result.isSuccess`): Go's simple
    // `buckets.Run` call sits AFTER the `if err != nil { ...; return err }`
    // block above (`start.go:1271-1280`), so it's unreachable on the
    // `--ignore-health-check` downgrade-to-warning fallthrough — that
    // fallthrough still `return`s the original unhealthy error before ever
    // reaching it (mutually exclusive with the narrower storage-only
    // recheck-and-seed path implemented above, inside the
    // `Result.isFailure(healthResult)` branch: that branch only runs when
    // this one's `Result.isSuccess(healthResult)` guard is false).
    //
    // A seeding failure propagates as a normal command failure and still
    // rolls back: Go's top-level `Run()` (`start.go:73-81`) wraps `run()`'s
    // ENTIRE body — including this tail — in the same `DockerRemoveAll`-on-
    // error branch, and a plain seed error (unlike the health-check timeout
    // above) never satisfies `IsUnhealthyError`, so it always takes that
    // branch regardless of `--ignore-health-check`.
    if (Result.isSuccess(healthResult) && isFreshVolume && storageContainerId !== undefined) {
      yield* legacySeedBucketsRun({
        projectRef: "",
        emitSummary: false,
        interactive: false,
        yes: true,
      }).pipe(Effect.tapError(() => legacyRollbackStart(spawner, filterValue, isFreshVolume)));
    }

    // 11. Success ONLY: fire `cli_stack_started` exactly once, no
    // properties/groups, matching Go's real tail order (`start.go:1287`) —
    // that capture sits AFTER the entire `if err != nil { ...; return err }`
    // block (including the ignore-health-check downgrade path above), so a
    // genuine bulk-health-check failure never reaches it even when
    // `--ignore-health-check` downgrades it to a warning: Go's `run()`
    // itself still returns that error, and its caller (`Run()`) downgrades
    // it without ever re-invoking this capture.
    if (Result.isSuccess(healthResult)) {
      yield* analytics.capture(EventStackStarted, {});
    }

    // Go's `status.PrettyPrint(os.Stdout, excludedContainers...)` (`start.go:85`)
    // trusts "config-enabled + not --exclude'd" as a proxy for "actually
    // running" — a true invariant in Go, since `run()` would have already
    // failed and rolled back before reaching here if any enabled, non-excluded
    // container's `DockerStart` failed. Edge Runtime now genuinely starts under
    // that same gate (no more force-exclusion from status rendering), so the
    // raw `--exclude` values are enough on their own.
    const statusExcluded = flags.exclude;

    if (output.format === "text") {
      yield* output.raw(legacyStartCompletedMessage(), "stderr");
      // Called DIRECTLY, unlike the already-running branch's `status.Run`: no
      // re-health-check, no "stopped services" diffing, just the raw
      // `--exclude` values against the config/values already resolved (and
      // just health-checked) above.
      const { values: statusValues, names } = yield* buildStatusValues(statusExcluded);
      yield* output.raw(legacyRenderStatusPretty(statusValues, names));
      yield* output.raw(legacyStartSecurityNotice(), "stderr");
    } else {
      const { values: statusValues } = yield* buildStatusValues(statusExcluded);
      yield* output.success("", statusValues);
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});

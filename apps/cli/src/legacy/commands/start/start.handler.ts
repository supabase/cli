import {
  inferFunctionsManifest,
  parseStorageSizeBytes,
  resolveProjectSubtree,
  type ProjectConfig,
} from "@supabase/config";
import { join } from "node:path";
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
import {
  legacyApiTlsCertReadErrorMessage,
  legacyApiTlsKeyReadErrorMessage,
  legacyResolveApiTlsPath,
  legacyResolveEmailTemplateContentPath,
} from "../../shared/legacy-config-validate.ts";
import { legacyCheckDbToml } from "../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../shared/legacy-db-connection.service.ts";
import { legacyResolveEdgeRuntimeImage } from "../../shared/legacy-edge-runtime-image.ts";
import { legacyResolveDbImage } from "../../shared/legacy-db-image.ts";
import {
  legacyResolveStorageCredentials,
  legacyStorageGatewayFetch,
} from "../../shared/legacy-storage-credentials.ts";
import { legacyReadServiceVersionOverrides } from "../../shared/legacy-service-version-overrides.ts";
import {
  legacyCollectDotenvPrivateKeys,
  legacyDecryptSecret,
  legacyIsEncryptedSecret,
} from "../../shared/legacy-vault-decrypt.ts";
import { legacyTempPaths } from "../../shared/legacy-temp-paths.ts";
import { legacyParseGoDuration } from "../../../shared/config/go-duration.ts";
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
  type LegacyContainerIdName,
} from "../../shared/legacy-docker-lifecycle.ts";
import { legacyDockerRemoveAll } from "../../shared/legacy-docker-remove-all.ts";
import {
  legacyEnvOverride,
  legacyEnvOverrideApiMaxRows,
  legacyEnvOverrideBool,
  legacyEnvOverrideDefaultPoolSize,
  legacyEnvOverrideDenoVersion,
  legacyEnvOverrideEdgeRuntimePolicy,
  legacyEnvOverrideMajorVersion,
  legacyEnvOverrideMaxClientConn,
  legacyEnvOverridePoolMode,
  legacyEnvOverridePort,
  legacyEnvOverrideRealtimeIpVersion,
  legacyEnvOverrideRealtimeMaxHeaderLength,
  legacyEnvOverrideUint,
  legacyRawUnmodeledBool,
  legacyResolveAuthCaptcha,
  legacyResolveAuthEmail,
  legacyResolveAuthEmailSmtp,
  legacyResolveAuthExternalProviders,
  legacyResolveAuthHooks,
  legacyResolveAuthMfa,
  legacyResolveAuthSms,
  legacyResolveConfiguredSigningKeys,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveLocalConfigValues,
  legacyResolveLocalJwks,
  legacyStrToArr,
  type LegacyLocalConfigValues,
  type LegacyResolvedAuthEmail,
} from "../../shared/legacy-local-config-values.ts";
import {
  legacyLoadLocalProjectContext,
  type LegacyLocalProjectContext,
} from "../../shared/legacy-local-project-context.ts";
import { legacySeedBucketsRun } from "../../shared/legacy-seed-buckets.ts";
import { legacyCleanupStartSecrets } from "../../shared/legacy-start-secrets-cleanup.ts";
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
  LEGACY_COMPOSE_PROJECT_LABEL,
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
  type LegacyHealthCheckTimeoutError,
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
  legacyBuildGotrueContainerSpec,
  type LegacyBuildGotrueEnvInput,
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
import { legacyBuildPgMetaContainerSpec } from "./services/pg-meta.service.ts";
import { legacyBuildStudioContainerSpec } from "./services/studio.service.ts";
import { legacyBuildSupavisorContainerSpec } from "./services/supavisor.service.ts";

/**
 * `Config.Analytics.ApiKey`'s only possible value (`apps/cli-go/pkg/config/
 * config.go:307,529`) — `toml:"-"`, so never configurable. Duplicated locally
 * rather than hoisted: `logflare.service.ts`/`studio.service.ts` each already
 * hardcode this same Go compile-time literal independently, matching that
 * existing precedent instead of introducing a new shared constant for it.
 */
const LEGACY_ANALYTICS_API_KEY = "api-key";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Docker's/Podman's "container doesn't exist" stderr shapes for `container inspect`: "No such
 * container" or "No such object" depending on daemon version/CLI path — the same pair already
 * handled in `shared/functions/serve.ts`/`legacy-db-bootstrap.seam.layer.ts`/`legacy-pgdelta.seam.
 * layer.ts`.
 */
function isContainerNotFoundMessage(message: string): boolean {
  return (
    /no such container/iu.test(message) ||
    /no such object/iu.test(message) ||
    /no container with name or id/iu.test(message)
  );
}

/**
 * Wraps a synchronous `legacyEnvOverride*`/`legacyEnvOverride*` config-override read that throws on a
 * malformed value into a typed `LegacyStartInvalidConfigError` failure, matching Go's
 * `Config.Load` hard-failing on a bad Viper decode (`pkg/config/config.go:749-756`) before any
 * Docker work runs — instead of leaking an untyped Effect defect that bypasses
 * `withJsonErrorHandling`'s `Effect.catch` (which, unlike this pipeline's `Effect.onError`
 * rollback, only intercepts typed failures, never defects).
 */
function wrapConfigOverride<T>(
  dottedFieldPath: string,
  thunk: () => T,
): Effect.Effect<T, LegacyStartInvalidConfigError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      new LegacyStartInvalidConfigError({
        message: `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

/**
 * Go's `Db.HealthTimeout` (`internal/db/start/start.go:180`) — a duration
 * STRING (`"2m"` default, `packages/config/src/db.ts`), unlike every other
 * `start` health wait, which uses the fixed 30s `serviceTimeout` global
 * (`apps/cli-go/internal/start/start.go:161,1271`). Go decodes this field via
 * `mapstructure.StringToTimeDurationHookFunc()` inside the same
 * `v.UnmarshalExact` call every `SUPABASE_*` override goes through
 * (`pkg/config/config.go:749-756,775-784`) — a malformed value hard-fails
 * `Config.Load` (`"failed to parse config: %w"`) before `start` ever runs; it
 * is never silently replaced with a default. A valid-but-degenerate value
 * (e.g. `"0s"`) isn't special-cased either: Go's backoff policy computes
 * `uint64(timeout.Seconds())` as the retry count
 * (`internal/db/start/start.go:192-198`), and the backoff library returns
 * `Stop` immediately when that count is `0` — i.e. exactly one immediate
 * health probe with no wait, not a 30s fallback. Throws on a malformed
 * value; the caller wraps that into `LegacyStartInvalidConfigError` so
 * rollback still fires (a plain throw here would surface as an
 * Effect defect instead of a typed failure).
 */
function resolveDbHealthTimeoutSeconds(healthTimeout: string): number {
  return Math.trunc(legacyParseGoDuration(healthTimeout) / 1_000_000_000);
}

/**
 * Go's `appendGotruePasskeyEnv`/`Auth.Passkey`/`Auth.Webauthn` presence gate
 * (`start.go:1427-1440`, `pkg/config/config.go:1117-1134`): `@supabase/config`
 * has no `auth.passkey`/`auth.webauthn` schema fields at all, so presence and
 * every field must come from the raw, pre-schema TOML document instead — same
 * document-based approach `legacy-local-config-values.ts` already uses for
 * these two sections.
 */
/**
 * `auth.passkey.enabled`/`auth.webauthn.*` are Viper-bound like every other
 * nested field once `[auth.passkey]`/`[auth.webauthn]` are present in
 * config.toml (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`),
 * so `SUPABASE_AUTH_PASSKEY_ENABLED`/`SUPABASE_AUTH_WEBAUTHN_{RP_ID,
 * RP_DISPLAY_NAME,RP_ORIGINS}` overrides apply before `appendGotruePasskeyEnv`
 * (`start.go:1427-1436`) builds GoTrue's env — same reasoning, and same
 * presence-gating (an absent section is never synthesized from an env
 * override alone), as `legacy-local-config-values.ts`'s identical
 * `Config.Validate`-parity resolution for this raw-document pair.
 * `rp_display_name` has no validation-path precedent (Go's `Config.Validate`
 * never checks it), but GoTrue's env does consume it, so it gets the same
 * treatment here.
 */
function resolveGotruePasskeyWebauthn(
  document: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): {
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
  const passkeyEnabled =
    passkeyDoc !== undefined
      ? legacyEnvOverrideBool(
          "SUPABASE_AUTH_PASSKEY_ENABLED",
          legacyRawUnmodeledBool(passkeyDoc["enabled"], "auth.passkey.enabled"),
          "auth.passkey.enabled",
          projectEnvValues,
        )
      : undefined;
  const rpOriginsOverride =
    webauthnDoc !== undefined
      ? legacyEnvOverride("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined, projectEnvValues)
      : undefined;
  const webauthn =
    webauthnDoc !== undefined
      ? {
          rpId:
            legacyEnvOverride(
              "SUPABASE_AUTH_WEBAUTHN_RP_ID",
              typeof webauthnDoc["rp_id"] === "string" ? webauthnDoc["rp_id"] : "",
              projectEnvValues,
            ) ?? "",
          rpDisplayName:
            legacyEnvOverride(
              "SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME",
              typeof webauthnDoc["rp_display_name"] === "string"
                ? webauthnDoc["rp_display_name"]
                : "",
              projectEnvValues,
            ) ?? "",
          // Go's mapstructure decode chain applies `StringToSliceHookFunc(",")`
          // unconditionally to every `[]string`-typed field (`config.go:775-784`) — a raw or
          // `env(...)`-resolved `rp_origins` string (this section has no `@supabase/config`
          // schema at all) is comma-split, not silently dropped to `[]`.
          rpOrigins: (() => {
            if (rpOriginsOverride !== undefined) return legacyStrToArr(rpOriginsOverride);
            const raw = webauthnDoc["rp_origins"];
            if (Array.isArray(raw)) {
              return raw.filter((item): item is string => typeof item === "string");
            }
            return typeof raw === "string" ? legacyStrToArr(raw) : [];
          })(),
        }
      : undefined;
  return { passkeyEnabled, webauthn };
}

/**
 * Go's `Auth.Sessions` (`pkg/config/auth.go:330-333`) is a value-typed struct,
 * always merged with a Viper default (empty durations) regardless of
 * `[auth.sessions]` presence in config.toml — so
 * `SUPABASE_AUTH_SESSIONS_{TIMEBOX,INACTIVITY_TIMEOUT}` overrides always apply
 * before `start.go` builds `GOTRUE_SESSIONS_*`, no raw-document presence gate
 * needed (same reasoning as {@link resolveGotrueRateLimit}/mfa below).
 * `@supabase/config`'s `sessions` schema is `Schema.optionalKey` at the
 * `auth` level though (`config.auth.sessions` can be `undefined`), unlike
 * Go's always-present struct — an env override must still be able to
 * introduce a value even when the section was never in config.toml at all,
 * matching Go's real behavior.
 */
function resolveGotrueSessions(
  sessions: ProjectConfig["auth"]["sessions"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ProjectConfig["auth"]["sessions"] {
  const timebox = legacyEnvOverride(
    "SUPABASE_AUTH_SESSIONS_TIMEBOX",
    sessions?.timebox,
    projectEnvValues,
  );
  const inactivityTimeout = legacyEnvOverride(
    "SUPABASE_AUTH_SESSIONS_INACTIVITY_TIMEOUT",
    sessions?.inactivity_timeout,
    projectEnvValues,
  );
  if (timebox === undefined && inactivityTimeout === undefined) return sessions;
  return { timebox, inactivity_timeout: inactivityTimeout };
}

/**
 * Go's `Auth.RateLimit` (`pkg/config/auth.go:200-208`) is a value-typed
 * struct of plain `uint`s, always Viper-bound regardless of `[auth.rate_
 * limit]` presence, so every `SUPABASE_AUTH_RATE_LIMIT_*` override applies
 * before `start.go` builds `GOTRUE_RATE_LIMIT_*` — no raw-document presence
 * gate needed, matching the existing `db.pooler`/SMS numeric-field precedent.
 */
function resolveGotrueRateLimit(
  rateLimit: ProjectConfig["auth"]["rate_limit"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ProjectConfig["auth"]["rate_limit"] {
  return {
    anonymous_users: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS",
      "auth.rate_limit.anonymous_users",
      rateLimit.anonymous_users,
      projectEnvValues,
    ),
    token_refresh: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_TOKEN_REFRESH",
      "auth.rate_limit.token_refresh",
      rateLimit.token_refresh,
      projectEnvValues,
    ),
    sign_in_sign_ups: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_SIGN_IN_SIGN_UPS",
      "auth.rate_limit.sign_in_sign_ups",
      rateLimit.sign_in_sign_ups,
      projectEnvValues,
    ),
    token_verifications: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_TOKEN_VERIFICATIONS",
      "auth.rate_limit.token_verifications",
      rateLimit.token_verifications,
      projectEnvValues,
    ),
    email_sent: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT",
      "auth.rate_limit.email_sent",
      rateLimit.email_sent,
      projectEnvValues,
    ),
    sms_sent: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_SMS_SENT",
      "auth.rate_limit.sms_sent",
      rateLimit.sms_sent,
      projectEnvValues,
    ),
    web3: legacyEnvOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_WEB3",
      "auth.rate_limit.web3",
      rateLimit.web3,
      projectEnvValues,
    ),
  };
}

/**
 * Go's `Auth.Web3` (`pkg/config/auth.go:379-382`) is a value-typed struct —
 * same no-presence-gate reasoning as {@link resolveGotrueRateLimit}.
 */
function resolveGotrueWeb3(
  web3: ProjectConfig["auth"]["web3"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ProjectConfig["auth"]["web3"] {
  return {
    solana: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_WEB3_SOLANA_ENABLED",
        web3.solana.enabled,
        "auth.web3.solana.enabled",
        projectEnvValues,
      ),
    },
    ethereum: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_WEB3_ETHEREUM_ENABLED",
        web3.ethereum.enabled,
        "auth.web3.ethereum.enabled",
        projectEnvValues,
      ),
    },
  };
}

/**
 * Go's `Auth.OAuthServer` (`pkg/config/auth.go:394-398`) is a value-typed
 * struct — same no-presence-gate reasoning as {@link resolveGotrueRateLimit}.
 */
function resolveGotrueOAuthServer(
  oauthServer: ProjectConfig["auth"]["oauth_server"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ProjectConfig["auth"]["oauth_server"] {
  return {
    enabled: legacyEnvOverrideBool(
      "SUPABASE_AUTH_OAUTH_SERVER_ENABLED",
      oauthServer.enabled,
      "auth.oauth_server.enabled",
      projectEnvValues,
    ),
    authorization_url_path:
      legacyEnvOverride(
        "SUPABASE_AUTH_OAUTH_SERVER_AUTHORIZATION_URL_PATH",
        oauthServer.authorization_url_path,
        projectEnvValues,
      ) ?? oauthServer.authorization_url_path,
    allow_dynamic_registration: legacyEnvOverrideBool(
      "SUPABASE_AUTH_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION",
      oauthServer.allow_dynamic_registration,
      "auth.oauth_server.allow_dynamic_registration",
      projectEnvValues,
    ),
  };
}

/**
 * Every value {@link legacyBuildGotrueContainerSpec} needs from `config`/
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
  return legacyEnvOverride(
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
  readonly resolvedEmail: LegacyResolvedAuthEmail;
}): Omit<LegacyBuildGotrueEnvInput, "dbHost" | "dbPassword"> {
  const { context, values, workdir, kongContainerName, mailpitContainerName, resolvedEmail } =
    params;
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
  // Same generic-Viper-override gap as `inbucketEnabled` above, for
  // `local_smtp.admin_email`/`sender_name` — value-typed fields, so no
  // raw-document presence gate needed, matching `local_smtp.port`'s
  // existing treatment.
  const mailpitAdminEmail = legacyEnvOverride(
    "SUPABASE_LOCAL_SMTP_ADMIN_EMAIL",
    config.local_smtp.admin_email,
    projectEnvValues,
  );
  const mailpitSenderName = legacyEnvOverride(
    "SUPABASE_LOCAL_SMTP_SENDER_NAME",
    config.local_smtp.sender_name,
    projectEnvValues,
  );
  const mailpit =
    smtp === undefined && inbucketEnabled
      ? {
          containerName: mailpitContainerName,
          adminEmail: mailpitAdminEmail,
          senderName: mailpitSenderName,
        }
      : undefined;

  const { passkeyEnabled, webauthn } = resolveGotruePasskeyWebauthn(document, projectEnvValues);
  const externalProviders = legacyResolveAuthExternalProviders(
    asRecord(document?.["auth"]),
    config.auth.external,
    projectEnvValues,
  );
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
    email: resolvedEmail,
    kongContainerName,
    smtp,
    mailpit,
    sms: legacyResolveAuthSms(asRecord(document?.["auth"]), config.auth.sms, projectEnvValues),
    sessions: resolveGotrueSessions(config.auth.sessions, projectEnvValues),
    mfa: legacyResolveAuthMfa(config.auth.mfa, projectEnvValues),
    rateLimit: resolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
    web3: resolveGotrueWeb3(config.auth.web3, projectEnvValues),
    oauthServer: resolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
    hooks: legacyResolveAuthHooks(asRecord(document?.["auth"]), config.auth.hook, projectEnvValues),
    captcha: legacyResolveAuthCaptcha(
      asRecord(document?.["auth"]),
      config.auth.captcha,
      projectEnvValues,
    ),
    passkeyEnabled,
    webauthn,
    externalProviders,
    signingKeys: legacyResolveConfiguredSigningKeys(config, workdir, projectEnvValues),
  };
}

/**
 * Go's `mountEmailTemplates` call sites for Kong (`start.go:544-558`): every configured template,
 * then every ENABLED notification, suffixed `_notification`.
 *
 * Go's `baseConfig.resolve` (`config.go:901-916`) rebases `ContentPath` once at config-load time,
 * BEFORE `mountEmailTemplates` ever runs: templates against `workdir`, notifications against
 * `join(workdir, "supabase")` — the same asymmetric base `legacyResolveEmailTemplateContentPath`
 * already applies for the file-existence check in `readAuthEmailTemplateContent`. Notification
 * `content_path` here must go through that same rebase before reaching Kong's mount builder, or a
 * relative notification path gets validated against `<workdir>/supabase/...` but mounted from
 * `<workdir>/...`. Template entries need no rebase — `workdir` is already their correct base.
 */
function buildKongEmailTemplateMounts(
  email: LegacyResolvedAuthEmail,
  workdir: string,
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
        contentPath:
          legacyResolveEmailTemplateContentPath({
            section: "notification",
            name: id,
            contentPath: notification.content_path,
            contentPresent: false,
            base: join(workdir, "supabase"),
          }) ?? "",
      })),
  ];
}

/**
 * What `--ignore-health-check` prints when it downgrades a health-check timeout
 * to a warning. That decision belongs to this caller, not `lib/health-check.ts`
 * (which only implements the polling contract), and it writes straight to
 * stderr — bypassing the `Output.fail` renderer that would otherwise append the
 * error's `suggestion` for it.
 */
function legacyHealthWarningText(error: LegacyHealthCheckTimeoutError): string {
  return error.suggestion === undefined ? error.message : `${error.message}\n${error.suggestion}`;
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
  // Threaded into every `legacyDockerRemoveAll` teardown below — Go's
  // `--debug` gates that function's `Pruned …:` stderr reports
  // (`docker.go:123-143`, `viper.GetBool("DEBUG")`).
  const debug = yield* LegacyDebugFlag;

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
    // Single source resolved once, fed to both Kong's template mounts and GoTrue's env builder —
    // see {@link legacyResolveAuthEmail}'s doc comment.
    const resolvedEmail = yield* Effect.try({
      try: () =>
        legacyResolveAuthEmail(
          config.auth.email,
          asRecord(context.loaded?.document?.["auth"]),
          projectEnvValues,
        ),
      catch: (cause) =>
        new LegacyStartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    // Go decodes every `time.Duration` config field — including these 5 — in the same single,
    // unconditional `Config.Load` pass (`mapstructure.StringToTimeDurationHookFunc()`,
    // `pkg/config/config.go:749-756,777`), before `start` touches Docker at all
    // (`internal/start/start.go:51,73`). The TS port only parses them inside GoTrue's own env
    // builder (`gotrue.service.ts`), which never runs at all when auth is disabled or `gotrue` is
    // excluded — so a malformed value would otherwise be silently accepted instead of failing the
    // command, unlike Go. Validate eagerly here, discarding the parsed nanosecond counts, since
    // `resolveGotrueEnvInput` (below) re-resolves and re-parses these same fields for the actual
    // GoTrue container build.
    const gotrueSessionsForValidation = resolveGotrueSessions(
      config.auth.sessions,
      projectEnvValues,
    );
    yield* wrapConfigOverride("auth.email.max_frequency", () =>
      legacyParseGoDuration(resolvedEmail.max_frequency),
    );
    // Wrapped like `resolvedEmail` above: `legacyResolveLocalConfigValues`'s own SMS validation
    // only runs `if (authEnabled)` (`legacy-local-config-values.ts`), so this direct call is the
    // ONLY place a malformed `auth.sms.*` override is ever caught when auth is disabled — an
    // unwrapped throw here would surface as an Effect defect instead of the normal
    // `LegacyStartInvalidConfigError` config-load failure.
    const smsForValidation = yield* Effect.try({
      try: () =>
        legacyResolveAuthSms(
          asRecord(context.loaded?.document?.["auth"]),
          config.auth.sms,
          projectEnvValues,
        ),
      catch: (cause) =>
        new LegacyStartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    yield* wrapConfigOverride("auth.sms.max_frequency", () =>
      legacyParseGoDuration(smsForValidation.max_frequency),
    );
    // Go's `(s *sms) validate()` (`config.go:1412-1415`) prints this and downgrades
    // `EnableSignup` to `false` when no provider is enabled — `legacyResolveAuthSms` already
    // applies the downgrade itself, so this only needs to detect whether that branch fired (the
    // user configured `enable_signup = true` with every provider disabled) to reproduce the
    // matching warning.
    if (
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
    if (gotrueSessionsForValidation?.timebox !== undefined) {
      yield* wrapConfigOverride("auth.sessions.timebox", () =>
        legacyParseGoDuration(gotrueSessionsForValidation.timebox!),
      );
    }
    if (gotrueSessionsForValidation?.inactivity_timeout !== undefined) {
      yield* wrapConfigOverride("auth.sessions.inactivity_timeout", () =>
        legacyParseGoDuration(gotrueSessionsForValidation.inactivity_timeout!),
      );
    }
    yield* wrapConfigOverride("auth.mfa.phone.max_frequency", () =>
      legacyParseGoDuration(
        legacyResolveAuthMfa(config.auth.mfa, projectEnvValues).phone.max_frequency,
      ),
    );
    // Same gap for the remaining GoTrue overrides: `auth.rate_limit.*` (plain `uint`s) and
    // `auth.web3.*.enabled`/`auth.oauth_server.{enabled,allow_dynamic_registration}` (plain
    // `bool`s) are all decoded unconditionally in Go's single `Config.Load` pass
    // (`pkg/config/auth.go:200-208,371-382,394-398`), regardless of `auth.enabled`/`--exclude
    // gotrue`. `resolveGotrueRateLimit`/`resolveGotrueWeb3`/`resolveGotrueOAuthServer` already
    // throw internally on a bad override, so — unlike the duration fields above — calling each
    // whole (pure) function once here is simpler than re-deriving every field individually;
    // `resolveGotrueEnvInput` below re-resolves them a second time for the real container build,
    // which is safe since they're pure. `auth.oauth_server.authorization_url_path` is a plain
    // string and can't throw, so it needs no eager check.
    yield* wrapConfigOverride("auth.rate_limit", () =>
      resolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
    );
    yield* wrapConfigOverride("auth.web3", () =>
      resolveGotrueWeb3(config.auth.web3, projectEnvValues),
    );
    yield* wrapConfigOverride("auth.oauth_server", () =>
      resolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
    );
    // Same gap for `auth.passkey.enabled`/`auth.webauthn.*` and per-provider `auth.external.
    // <name>.{enabled,skip_nonce_check,email_optional}` — Go decodes these raw (unmodeled by
    // `@supabase/config`) booleans in the same unconditional `Config.Load` pass as the fields
    // above (`pkg/config/auth.go:166-176,190,361-391`), regardless of `auth.enabled`/`--exclude
    // gotrue`. Both resolvers already throw internally on a bad raw bool (`legacyRawUnmodeledBool`)
    // and are otherwise only reached from `resolveGotrueEnvInput`'s `case "gotrue":` branch below —
    // itself gated on auth being enabled and gotrue not excluded — so calling each here, once,
    // eagerly and discarding the result, closes the same "validates but doesn't reach it" gap.
    yield* wrapConfigOverride("auth.passkey", () =>
      resolveGotruePasskeyWebauthn(context.loaded?.document, projectEnvValues),
    );
    yield* wrapConfigOverride("auth.external", () =>
      legacyResolveAuthExternalProviders(
        asRecord(context.loaded?.document?.["auth"]),
        config.auth.external,
        projectEnvValues,
      ),
    );
    // Go's `function` struct (`pkg/config/config.go:290-296`) has no `env` field — `Config.Load`'s
    // `v.UnmarshalExact` (`ErrorUnused: true`, `config.go:749,1041`) rejects any unknown key
    // unconditionally, well before any Docker work. `@supabase/config`'s own schema DOES model
    // `[functions.<slug>.env]` (`packages/config/src/functions.ts`) — a legitimate `next/`-only
    // feature shared infrastructure the legacy shell can't remove — so this is a legacy-only
    // rejection, not a schema change. Empirically confirmed against the real Go binary: a config
    // with `[functions.foo.env]` fails with `'functions[foo]' has invalid keys: env`.
    for (const [slug, func] of Object.entries(config.functions)) {
      if (Object.keys(func.env).length > 0) {
        yield* Effect.fail(
          new LegacyStartInvalidConfigError({
            message: `failed to parse config: decoding failed due to the following error(s):\n\n'functions[${slug}]' has invalid keys: env`,
          }),
        );
      }
    }
    // `legacyCheckDbToml` resolves `[db.vault]`/`[db.seed]`/`db.migrations.enabled`/the effective
    // `api.auto_expose_new_tables` tri-state the same way Go's `Config.Load`/`Validate` does —
    // unconditionally, before any Docker work (`config.go` decode + validate pass). The port only
    // ran this inside `legacyStartSetupLocalDatabase`, which is itself gated on the DB container's
    // healthcheck passing AND a fresh volume (Go's `NoBackupVolume` gate) — so a malformed
    // `SUPABASE_DB_SEED_ENABLED`/an undecryptable `[db.vault]` secret went completely unvalidated
    // whenever `start` reused an existing volume. Called here purely for its validation side
    // effect and discarded — `legacyStartSetupLocalDatabase`'s own internal call (an already-
    // accepted duplicate config-load pass, matching `db start`'s own independent resolution — see
    // `lib/db-setup.ts`'s header) still resolves the real value for its own use when it runs.
    yield* legacyCheckDbToml(fs, path, cliConfig.workdir).pipe(Effect.asVoid);

    const dbContainerId = localDbContainerId(projectId);
    const filterValue = legacyCliProjectFilterValue(projectId);

    // Shared status-values helper — reused by BOTH the already-running branch
    // (full `status.Run` pipeline, health-checked + "stopped" diffed) and the
    // success path at the end (Go's direct `status.PrettyPrint`/`toValues`
    // call, no re-health-check — see each call site's own comment for why
    // they differ).
    //
    // `precomputedLocal` is only ever passed by the success-path call: Go's
    // already-running branch delegates to `status.Run`, which calls
    // `flags.LoadConfig` (and therefore re-derives keys) a SECOND time in that
    // same process (`start.go:51` then `status.go:101`), so recomputing here
    // matches Go exactly. The success path, by contrast, never calls
    // `LoadConfig` again after bring-up — it prints straight from the
    // already-populated config (`start.go:85`) — so it must reuse the SAME
    // `values` that were already used to build every container spec, instead
    // of re-deriving (and, for asymmetric JWTs, re-signing with a new `exp`) a
    // second time. See {@link legacyResolveStatusLocalState}'s
    // `precomputedLocal` param doc for why a second derivation is unsafe.
    const buildStatusValues = Effect.fnUntraced(function* (
      excluded: ReadonlyArray<string>,
      precomputedLocal?: LegacyLocalConfigValues,
    ) {
      const localState = yield* Effect.try({
        try: () =>
          legacyResolveStatusLocalState(
            context.config,
            context.hostname,
            cliConfig.workdir,
            context.projectEnvValues,
            context.loaded?.document,
            precomputedLocal,
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

    const isBitbucketPipeline = legacyIsBitbucketPipeline();

    // 3. Missing proceeds to startup; other inspect failures propagate.
    // Unlike Go, verified stopped stacks are recovered unless Bitbucket's lack of named volumes
    // makes removing the Postgres container destructive.
    const inspectDbState = legacyInspectContainerState(spawner, dbContainerId).pipe(
      Effect.catch((error) =>
        isContainerNotFoundMessage(error.message) ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    const dbState = yield* inspectDbState;
    const isRecoverableStoppedState = (
      state: { readonly running: boolean; readonly status: string } | undefined,
    ) =>
      // `created` may own a just-provisioned volume that Postgres never initialized.
      state?.running === false && state.status.length > 0 && state.status !== "created";
    const shouldRecoverStoppedStack = isRecoverableStoppedState(dbState) && !isBitbucketPipeline;

    const reportAlreadyRunningStatus = Effect.fnUntraced(function* () {
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
    });

    if (dbState !== undefined && !shouldRecoverStoppedStack) {
      return yield* reportAlreadyRunningStatus();
    }

    // 4. Go's `flags.LoadProjectRef`/`services.CheckVersions` best-effort
    // update-suggestion (`start.go:61-63`): a Management API call gated on the
    // project being linked AND the user being logged in, purely to print an
    // "update available" hint, every error silently swallowed. Deliberately
    // NOT implemented — this command has zero Management API dependency by
    // design; omission confirmed against source, not missed.

    // 5. Gate evaluation — see `start.gates.ts` for the full boolean table.
    // `legacyEnvOverrideBool` throws synchronously on an unparsable value (matching Go's
    // `Config.Load` hard-failing on a bad Viper bool decode, `pkg/config/config.go:749-756`) —
    // wrapped so that throw becomes the typed `LegacyStartInvalidConfigError` every other
    // malformed-config path in this handler uses, not an untyped Effect defect.
    const gates = yield* Effect.try({
      try: () =>
        legacyResolveStartGates({
          config,
          projectEnvValues,
          excludedKeys,
          document: context.loaded?.document,
        }),
      catch: (cause) =>
        new LegacyStartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

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
    const orioledbVersion = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
      config.experimental.orioledb_version,
      projectEnvValues,
    );
    // Same generic-Viper-override gap as `orioledbVersion` above, for its four
    // sibling S3 fields Go reads into the Postgres container's `S3_*` env
    // alongside `orioledb_version` (`apps/cli-go/internal/db/start/
    // start.go:70-77`) — also threaded into the Postgres container spec
    // below, since `legacyPostgresExtraEnv` reads these same fields raw.
    const s3Host = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_HOST",
      config.experimental.s3_host,
      projectEnvValues,
    );
    // Go's one-shot fresh-DB setup jobs (`initSchema15`) read `utils.Config.
    // {Realtime,Storage,Auth}.Enabled` — the EFFECTIVE, env-overridden value — and run
    // regardless of `--exclude` (`internal/db/start/start.go:270,299,321`) WHENEVER they
    // actually execute (see the `isFreshVolume`/`majorVersion >= 15` gate further down,
    // where these booleans also gate that conditional image resolve). Hoisted here
    // (rather than recomputed only inside the `isFreshVolume` block below) since
    // `legacyStartSetupLocalDatabase`'s own config object a few hundred lines down also
    // needs them, and computing them once keeps both consumers in agreement.
    const realtimeEnabledForSetup = legacyEnvOverrideBool(
      "SUPABASE_REALTIME_ENABLED",
      config.realtime.enabled,
      "realtime.enabled",
      projectEnvValues,
    );
    const storageEnabledForSetup = legacyEnvOverrideBool(
      "SUPABASE_STORAGE_ENABLED",
      config.storage.enabled,
      "storage.enabled",
      projectEnvValues,
    );
    const authEnabledForSetup = legacyEnvOverrideBool(
      "SUPABASE_AUTH_ENABLED",
      config.auth.enabled,
      "auth.enabled",
      projectEnvValues,
    );
    const s3Region = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_REGION",
      config.experimental.s3_region,
      projectEnvValues,
    );
    const s3AccessKey = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY",
      config.experimental.s3_access_key,
      projectEnvValues,
    );
    const s3SecretKey = legacyEnvOverride(
      "SUPABASE_EXPERIMENTAL_S3_SECRET_KEY",
      config.experimental.s3_secret_key,
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
    const serviceVersionOverrides = yield* legacyReadServiceVersionOverrides(
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
    // Go's own pre-pull (`ensureImagesCached`, `start.go:237-262`) only ever touches
    // `project.Services`, already filtered to non-excluded services (`start.go:269-282`)
    // — the fresh-DB one-shot setup jobs' images are NOT pre-pulled here; Go resolves
    // those lazily, later, only from inside `initSchema15` when it actually runs (see the
    // conditional resolve further down, gated the same way that job itself is gated).
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
    //
    // `config.functions.<slug>.env.<VAR>` is schema-marked deferred
    // (`env(...)`, `packages/config/src/lib/env.ts`) and only gets its
    // literal interpolated by `resolveProjectSubtree` — without this step, a
    // configured `[functions.<slug>.env]` entry reaches Edge Runtime as the
    // literal string `"env(API_KEY)"` instead of the real secret.
    // `functions serve`'s own call site already resolves this subtree first
    // (`shared/functions/serve.ts:615-622`) before the same
    // `toPlainFunctionRecord` call — same reasoning as `resolvedEdgeRuntime`
    // below, just for the sibling `functions` subtree.
    const resolvedFunctions = yield* resolveProjectSubtree(
      config.functions,
      { values: projectEnvValues ?? {} },
      "functions",
      { goViperCompat: true },
    );
    const configDeclaredFunctions = toPlainFunctionRecord(resolvedFunctions);
    const configFunctions = yield* inferFunctionsManifest({
      cwd: cliConfig.workdir,
      config: { ...config, functions: configDeclaredFunctions },
      // `search: false`: `cliConfig.workdir` is already Go's fully-resolved chdir target (same
      // reasoning as `legacy-local-project-context.ts`'s `loadProjectEnvironment` call) — letting
      // `findProjectPaths` climb ancestors again here would let an unrelated ancestor project's
      // `supabase/functions` win when `--workdir`/`SUPABASE_WORKDIR` points at a subdirectory with
      // no `supabase/config.toml` of its own.
      search: false,
    });
    const rawConfigFunctions = rawFunctionConfigRecord(context.loaded?.document);
    // Resolve once during preflight so a missing function source cannot fail only after stopped
    // containers have been removed. Studio consumes the cached binds later during bring-up.
    const studioFunctionBinds = gates.studio
      ? yield* resolveFunctionBindMounts(
          projectId,
          cliConfig.workdir,
          `${cliConfig.workdir}/supabase`,
          { configDeclaredFunctions, configFunctions, rawConfigFunctions },
          Option.none(),
          Option.none(),
          cliConfig.workdir,
        )
      : new Set<string>();

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

    // Go gates the TLS cert/key disk read on the post-Viper-override `Api.Enabled` itself, not
    // just `Api.Tls.Enabled` (`pkg/config/config.go:1006-1027`: the whole `if c.Api.Enabled`
    // block, including the nested `if c.Api.Tls.Enabled` cert read, is skipped when API is
    // disabled, leaving `CertContent`/`KeyContent` at their embedded defaults). Not the SAME
    // `apiEnabled` `legacyResolveStartGates` (`start.gates.ts:87-92`) computes for its own
    // `gates.postgrest` — that one is additionally ANDed with `--exclude postgrest`, which has no
    // equivalent in Go's `Validate()` — so this is resolved separately here.
    const apiEnabled = yield* wrapConfigOverride("api.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_API_ENABLED",
        config.api.enabled,
        "api.enabled",
        projectEnvValues,
      ),
    );
    // Hoisted out of the "kong" case below (it used to be computed only
    // there): the post-bring-up health-probe CA-trust lookup near the end of
    // this function needs the SAME env-overridden value, not the raw
    // `config.api.tls.enabled` — Go has one source of truth here (`Config.
    // Load` applies `SUPABASE_API_TLS_ENABLED` before `Validate` populates
    // `Api.Tls.CertContent`, `pkg/config/config.go:586,749,882,1006-1019`),
    // and `status.NewKongClient`'s trust pool + its health probe's target URL
    // both read that same already-overridden global (`internal/status/
    // status.go:181-229`).
    const apiTlsEnabled = yield* wrapConfigOverride("api.tls.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_API_TLS_ENABLED",
        config.api.tls.enabled,
        "api.tls.enabled",
        projectEnvValues,
      ),
    );
    // Same generic-Viper-override gap as `apiTlsEnabled` above, for the two
    // custom cert/key path fields — Go's `Config.Load` applies
    // `SUPABASE_API_TLS_CERT_PATH`/`SUPABASE_API_TLS_KEY_PATH` before
    // `Validate` reads `CertPath`/`KeyPath` from disk into `CertContent`/
    // `KeyContent` (`pkg/config/config.go:1012-1024`). Mirrors the identical
    // resolution `legacy-local-config-values.ts` already does for `status`/`stop`.
    const apiTlsCertPath = legacyEnvOverride(
      "SUPABASE_API_TLS_CERT_PATH",
      config.api.tls.cert_path,
      projectEnvValues,
    );
    const apiTlsKeyPath = legacyEnvOverride(
      "SUPABASE_API_TLS_KEY_PATH",
      config.api.tls.key_path,
      projectEnvValues,
    );
    // Go's `NewConfig` seeds these from the embedded defaults, then `Validate`
    // replaces them from disk before `start.Run` can mutate Docker.
    let tlsCertContent = LEGACY_KONG_LOCAL_TLS_CERT;
    let tlsKeyContent = LEGACY_KONG_LOCAL_TLS_KEY;
    if (
      apiEnabled &&
      apiTlsEnabled &&
      apiTlsCertPath !== undefined &&
      apiTlsCertPath.length > 0 &&
      apiTlsKeyPath !== undefined &&
      apiTlsKeyPath.length > 0
    ) {
      tlsCertContent = yield* fs
        .readFileString(legacyResolveApiTlsPath(cliConfig.workdir, apiTlsCertPath))
        .pipe(
          Effect.mapError(
            (cause) =>
              new LegacyStartInvalidConfigError({
                message: legacyApiTlsCertReadErrorMessage(cause),
              }),
          ),
        );
      tlsKeyContent = yield* fs
        .readFileString(legacyResolveApiTlsPath(cliConfig.workdir, apiTlsKeyPath))
        .pipe(
          Effect.mapError(
            (cause) =>
              new LegacyStartInvalidConfigError({
                message: legacyApiTlsKeyReadErrorMessage(cause),
              }),
          ),
        );
    }

    // Same generic-Viper-override gap as `apiTlsEnabled` above, for Realtime's
    // two `SUPABASE_REALTIME_*` fields — both the Realtime container spec
    // below AND the PG15+ Realtime setup job (`legacyStartSetupLocalDatabase`,
    // via the `realtime` splice further down) must see the SAME
    // already-overridden values, matching Go's single `utils.Config.Realtime`
    // source of truth (`internal/start/start.go:922,928`,
    // `internal/db/start/start.go:283,290`).
    const realtimeIpVersion = yield* wrapConfigOverride("realtime.ip_version", () =>
      legacyEnvOverrideRealtimeIpVersion(config.realtime.ip_version, projectEnvValues),
    );
    const realtimeMaxHeaderLength = yield* wrapConfigOverride("realtime.max_header_length", () =>
      legacyEnvOverrideRealtimeMaxHeaderLength(config.realtime.max_header_length, projectEnvValues),
    );

    // Same gap for Storage's file-size limit — both the long-running
    // container below AND the one-shot storage migrate job
    // (`legacyStartSetupLocalDatabase`, via the `storage` splice further
    // down) must see the same already-overridden value (Go's
    // `internal/start/start.go:1004`, `internal/db/start/start.go:307`, both
    // reading the single `utils.Config.Storage.FileSizeLimit`).
    const storageFileSizeLimit =
      legacyEnvOverride(
        "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
        config.storage.file_size_limit,
        projectEnvValues,
      ) ?? config.storage.file_size_limit;
    // `@supabase/config`'s schema accepts `file_size_limit` as a plain string — it does not parse
    // the size grammar itself, so a malformed value (e.g. "foobar") would otherwise only surface
    // when Storage's byte-size parser builds the container env, well after
    // network/image/Postgres work, and never at all when Storage is excluded/disabled. Go's
    // `sizeInBytes.UnmarshalText` (`pkg/config/config.go:39-49`) decodes this unconditionally in
    // the same `Config.Load` pass as everything else (`config.go:749-756,775-784`), before `start`
    // touches Docker or looks at `--exclude` — validate eagerly here to match, discarding the
    // parsed byte count since every consumer re-parses `storageFileSizeLimit` itself.
    yield* wrapConfigOverride("storage.file_size_limit", () =>
      parseStorageSizeBytes(storageFileSizeLimit),
    );
    // Same gap for `storage.vector.enabled` — both the long-running Storage
    // container AND `legacySeedBucketsRun`'s `effectiveLocalStorageConfig`
    // splice further down must see the same already-overridden value (Go's
    // `internal/seed/buckets/buckets.go:54` reads the single
    // `utils.Config.Storage.VectorBuckets.Enabled`).
    const storageVectorEnabled = yield* wrapConfigOverride("storage.vector.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_VECTOR_ENABLED",
        config.storage.vector.enabled,
        "storage.vector.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `storage.s3_protocol.enabled` — a plain bool decoded via Go's generic
    // Viper/mapstructure `Config.Load` pass (`storage.go:43-45`, `s3Protocol.Enabled`), the exact
    // same mechanism as `storage.vector.enabled` above, unconditionally before any Docker work.
    // The Storage spec builder below only parsed this lazily, so it was silently accepted when
    // Storage is excluded/disabled — same class of gap already fixed for `storage.file_size_limit`,
    // the GoTrue duration fields, and `db.health_timeout`.
    const storageS3ProtocolEnabled = yield* wrapConfigOverride("storage.s3_protocol.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        config.storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `storage.analytics.enabled` — the `Enabled` bool sibling of the
    // `max_namespaces`/`max_tables`/`max_catalogs` uint fields validated below, all decoded in
    // the same generic Viper/mapstructure `Config.Load` pass, unconditionally, before any Docker
    // work. `start` itself never reads this field locally (only `seed buckets --linked` does,
    // unreachable from `start`'s own inline seeding since every call here passes
    // `projectRef: ""`) — validate purely for Go's fail-fast parity and discard the result, same
    // as the uint siblings below.
    yield* wrapConfigOverride("storage.analytics.enabled", () =>
      legacyEnvOverrideBool(
        "SUPABASE_STORAGE_ANALYTICS_ENABLED",
        config.storage.analytics.enabled,
        "storage.analytics.enabled",
        projectEnvValues,
      ),
    );
    // Go decodes `storage.analytics.{max_namespaces,max_tables,max_catalogs}` and
    // `storage.vector.{max_buckets,max_indexes}` as plain `uint`s in the same generic
    // Viper/mapstructure `Config.Load` pass as every other field above (`pkg/config/
    // storage.go:28-39`) — unconditionally, before any Docker work. Unlike their `enabled`
    // siblings above, `start`'s own logic never reads these fields (only `config push`/`pull`
    // do), so there is no downstream re-resolution to reuse — validate purely for Go's
    // fail-fast parity and discard the result.
    yield* wrapConfigOverride("storage.analytics.max_namespaces", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
        "storage.analytics.max_namespaces",
        config.storage.analytics.max_namespaces,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.analytics.max_tables", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
        "storage.analytics.max_tables",
        config.storage.analytics.max_tables,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.analytics.max_catalogs", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
        "storage.analytics.max_catalogs",
        config.storage.analytics.max_catalogs,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.vector.max_buckets", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
        "storage.vector.max_buckets",
        config.storage.vector.max_buckets,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.vector.max_indexes", () =>
      legacyEnvOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
        "storage.vector.max_indexes",
        config.storage.vector.max_indexes,
        projectEnvValues,
      ),
    );

    // Same gap for `api.schemas`/`api.extra_search_path`/`api.max_rows` — both
    // PostgREST's own container AND Studio's copy of the same PGRST_DB_* env
    // must see the same already-overridden values (Go's
    // `internal/start/start.go:968-970,1335-1337`, both reading the single
    // `utils.Config.Api.{Schemas,ExtraSearchPath,MaxRows}`). The two array
    // fields use the same comma-split-override pattern as
    // `auth.additional_redirect_urls`/`auth.webauthn.rp_origins` above.
    const apiSchemasOverride = legacyEnvOverride(
      "SUPABASE_API_SCHEMAS",
      undefined,
      projectEnvValues,
    );
    const apiSchemas =
      apiSchemasOverride !== undefined ? apiSchemasOverride.split(",") : config.api.schemas;
    const apiExtraSearchPathOverride = legacyEnvOverride(
      "SUPABASE_API_EXTRA_SEARCH_PATH",
      undefined,
      projectEnvValues,
    );
    const apiExtraSearchPath =
      apiExtraSearchPathOverride !== undefined
        ? apiExtraSearchPathOverride.split(",")
        : config.api.extra_search_path;
    const apiMaxRows = yield* wrapConfigOverride("api.max_rows", () =>
      legacyEnvOverrideApiMaxRows(config.api.max_rows, projectEnvValues),
    );

    // Same gap for Mailpit's three ports — Go's Config.Load applies
    // SUPABASE_LOCAL_SMTP_PORT/_SMTP_PORT/_POP3_PORT generically
    // (pkg/config/config.go:580-586) before internal/start/start.go:853-867
    // reads utils.Config.Inbucket.{Port,SmtpPort,Pop3Port} to build Mailpit's
    // port bindings. `smtp_port`/`pop3_port` have no TOML default (Go's
    // zero-value uint16), matching mailpit.service.ts's own `!== 0` publish
    // guard, so `?? 0` here preserves that "unconfigured" signal.
    const mailpitPort = yield* wrapConfigOverride("local_smtp.port", () =>
      legacyEnvOverridePort(
        "SUPABASE_LOCAL_SMTP_PORT",
        config.local_smtp.port,
        "local_smtp.port",
        projectEnvValues,
      ),
    );
    const mailpitSmtpPort = yield* wrapConfigOverride("local_smtp.smtp_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_LOCAL_SMTP_SMTP_PORT",
        config.local_smtp.smtp_port ?? 0,
        "local_smtp.smtp_port",
        projectEnvValues,
      ),
    );
    const mailpitPop3Port = yield* wrapConfigOverride("local_smtp.pop3_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_LOCAL_SMTP_POP3_PORT",
        config.local_smtp.pop3_port ?? 0,
        "local_smtp.pop3_port",
        projectEnvValues,
      ),
    );

    // Same gap for Logflare's port — Go's Config.Load applies
    // SUPABASE_ANALYTICS_PORT generically (pkg/config/config.go:582-586)
    // before start.go:378 reads utils.Config.Analytics.Port to build
    // Logflare's HostPort.
    const analyticsPort = yield* wrapConfigOverride("analytics.port", () =>
      legacyEnvOverridePort(
        "SUPABASE_ANALYTICS_PORT",
        config.analytics.port,
        "analytics.port",
        projectEnvValues,
      ),
    );
    // Same gap for Logflare's deprecated Vector port — Go's Config.Load decodes
    // `analytics.vector_port` (a `uint16`, "Deprecated together with syslog") unconditionally in
    // the same pass as `analytics.port` above; nothing downstream in `start` reads the resolved
    // value, but a malformed override must still fail before any Docker work, matching Go.
    // Result discarded — no native code path consumes it.
    yield* wrapConfigOverride("analytics.vector_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_ANALYTICS_VECTOR_PORT",
        config.analytics.vector_port ?? 0,
        "analytics.vector_port",
        projectEnvValues,
      ),
    );

    // Same gap for Supavisor's pooler fields — Go's Config.Load applies
    // SUPABASE_DB_POOLER_* generically (pkg/config/config.go:580-586) before
    // start.go:1194-1211 reads utils.Config.Db.Pooler.{Port,PoolMode,
    // DefaultPoolSize,MaxClientConn}; PoolMode specifically decides the
    // published host port (5432 session vs 6543 transaction). All four throw
    // synchronously on a malformed override — wrapped via `wrapConfigOverride` so a bad
    // value fails as a typed `LegacyStartInvalidConfigError` (matching Go's
    // `Config.Load` rejecting it before any Docker work) instead of an
    // untyped Effect defect bypassing `withJsonErrorHandling`'s `Effect.catch`
    // (see `wrapConfigOverride`'s doc comment) — same bug class already fixed
    // for `dbHealthTimeoutSeconds`/`db.settings`/the Edge Runtime
    // `policy`/`inspector_port` overrides elsewhere in this function.
    const poolerPort = yield* wrapConfigOverride("db.pooler.port", () =>
      legacyEnvOverridePort(
        "SUPABASE_DB_POOLER_PORT",
        config.db.pooler.port,
        "db.pooler.port",
        projectEnvValues,
      ),
    );
    const poolMode = yield* wrapConfigOverride("db.pooler.pool_mode", () =>
      legacyEnvOverridePoolMode(config.db.pooler.pool_mode, projectEnvValues),
    );
    const poolerDefaultPoolSize = yield* wrapConfigOverride("db.pooler.default_pool_size", () =>
      legacyEnvOverrideDefaultPoolSize(config.db.pooler.default_pool_size, projectEnvValues),
    );
    const poolerMaxClientConn = yield* wrapConfigOverride("db.pooler.max_client_conn", () =>
      legacyEnvOverrideMaxClientConn(config.db.pooler.max_client_conn, projectEnvValues),
    );

    // Overridden by SUPABASE_DB_HEALTH_TIMEOUT — Go's Config.Load binds this
    // generically before StartDatabase's health wait reads it
    // (pkg/config/config.go:580-586, internal/db/start/start.go:180). Resolved
    // here, before any Docker work, rather than inside `bringUp` right before the
    // health wait: Go's `mapstructure.StringToTimeDurationHookFunc()` decodes this
    // in the same unconditional `Config.Load` pass as every other field
    // (`pkg/config/config.go:749-756,777`), which runs before `start.Run` touches
    // Docker at all (`internal/start/start.go:51,73`) — a malformed value must
    // fail before network/image/Postgres work, not after Postgres's own container
    // has already been created and started.
    const dbHealthTimeout = legacyEnvOverride(
      "SUPABASE_DB_HEALTH_TIMEOUT",
      config.db.health_timeout,
      projectEnvValues,
    );
    const dbHealthTimeoutSeconds = yield* Effect.try({
      try: () => resolveDbHealthTimeoutSeconds(dbHealthTimeout ?? config.db.health_timeout),
      catch: (cause) =>
        new LegacyStartInvalidConfigError({
          message: `failed to parse config: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    // Same bug class as `dbHealthTimeoutSeconds` above: Go decodes `edge_runtime.policy`
    // (an enum via `UnmarshalText`) and `edge_runtime.inspector_port` (a plain `uint`) during
    // the same unconditional `Config.Load` pass (`pkg/config/config.go:749-756,777`), before
    // `start.Run` touches Docker — regardless of `--exclude edge-runtime`. The Edge Runtime
    // branch below re-resolves both against `resolvedEdgeRuntime`'s env-interpolated subtree
    // for the real container build; this eager call only needs the raw `config.edge_runtime`
    // value to prove it parses.
    const edgeRuntimePolicy = yield* wrapConfigOverride("edge_runtime.policy", () =>
      legacyEnvOverrideEdgeRuntimePolicy(config.edge_runtime.policy, projectEnvValues),
    );
    const edgeRuntimeInspectorPort = yield* wrapConfigOverride("edge_runtime.inspector_port", () =>
      legacyEnvOverridePort(
        "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
        config.edge_runtime.inspector_port,
        "edge_runtime.inspector_port",
        projectEnvValues,
      ),
    );

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
              port: analyticsPort,
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
              emailTemplateMounts: buildKongEmailTemplateMounts(resolvedEmail, cliConfig.workdir),
            }),
          };
        }

        case "gotrue":
          return {
            spec: legacyBuildGotrueContainerSpec({
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
                resolvedEmail,
              }),
            }),
          };

        case "mailpit":
          return {
            spec: legacyBuildMailpitContainerSpec({
              image,
              projectId,
              networkId,
              port: mailpitPort,
              smtpPort: mailpitSmtpPort,
              pop3Port: mailpitPop3Port,
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
              schemas: apiSchemas,
              extraSearchPath: apiExtraSearchPath,
              maxRows: apiMaxRows,
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
              s3ProtocolEnabled: storageS3ProtocolEnabled,
              imageTransformationEnabled: gates.imgproxy,
              vectorBucketsEnabled: storageVectorEnabled,
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
            spec: legacyBuildPgMetaContainerSpec({
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
          return {
            spec: legacyBuildStudioContainerSpec({
              image,
              containerName: studioContainerName,
              networkId,
              port: values.studioPort,
              // Go computes these whenever Studio is enabled, independently of Edge Runtime.
              // They are resolved during preflight above so recovery teardown remains reversible.
              functionBinds: [...studioFunctionBinds],
              env: {
                dbPassword,
                workdir: cliConfig.workdir,
                cliVersion: CLI_VERSION,
                pgMetaContainerName,
                kongContainerName,
                logflareContainerName,
                studioApiUrl: legacyResolveStudioApiUrl(
                  legacyEnvOverride(
                    "SUPABASE_STUDIO_API_URL",
                    config.studio.api_url,
                    projectEnvValues,
                  ) ?? config.studio.api_url,
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
                apiSchemas: apiSchemas,
                apiExtraSearchPath: apiExtraSearchPath,
                apiMaxRows: apiMaxRows,
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
              port: poolerPort,
              poolMode,
              defaultPoolSize: poolerDefaultPoolSize,
              maxClientConn: poolerMaxClientConn,
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
    // must survive PAST `bringUp`'s own failure path (`Effect.onError` below,
    // which runs on ANY failure — including a defect or interrupt — and has no
    // access to a value `bringUp` only returns on success) — there is no
    // non-mutable way to thread a value computed mid-effect into a sibling
    // failure handler.
    let isFreshVolume = false;

    // 8. Bring-up: network -> Postgres (+ its own health wait, GATED on
    // `--ignore-health-check` exactly like every other service's wait below —
    // Go's `Run()` checks `ignoreHealthCheck && IsUnhealthyError(err)` against
    // whatever `run()` returns AS A WHOLE (`start.go:73-81`), and `run()`
    // propagates `StartDatabase`'s error immediately (`start.go:294-298` ->
    // `db/start/start.go:180`), before "Starting containers..." even prints —
    // there is no Postgres-specific carve-out anywhere in Go) -> the
    // fresh-volume-gated `SetupLocalDatabase` equivalent (`db/start/
    // start.go:184-188`, BEFORE any other service starts) -> the 12 remaining
    // enabled+non-excluded services plus Edge Runtime, in Go's real start
    // order (`start.gates.ts`'s `imagePlan` + `edgeRuntime`). Any OTHER
    // failure in this whole phase (including a NON-ignored Postgres timeout)
    // rolls back and fails the command outright (Go's per-block `if err !=
    // nil { return err }`, propagated to `Run`'s rollback branch, `start.go:
    // 73-81`). An IGNORED Postgres timeout instead short-circuits to `{ kind:
    // "postgresUnhealthyIgnored" }` below — skipping every later step in this
    // phase, and the bulk health check/bucket seeding/`cli_stack_started`
    // capture after it — while still letting the command reach the final
    // "Started..." tail, matching Go's `Run()`, which prints the warning and
    // falls through to that SAME unconditional tail (`start.go:74-87`) rather
    // than returning early from the whole command.
    const bringUp = Effect.gen(function* () {
      yield* legacyEnsureStartNetwork(spawner, networkId, {
        [LEGACY_CLI_PROJECT_LABEL]: projectId,
        [LEGACY_COMPOSE_PROJECT_LABEL]: projectId,
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
        // `legacyPostgresExtraEnv` reads this same field, and its four sibling
        // S3 fields, for its S3/`POSTGRES_INITDB_ARGS` branch.
        experimental: {
          ...config.experimental,
          orioledb_version: orioledbVersion,
          s3_host: s3Host,
          s3_region: s3Region,
          s3_access_key: s3AccessKey,
          s3_secret_key: s3SecretKey,
        },
        jwtSecret: values.jwtSecret,
        // Overridden by SUPABASE_AUTH_JWT_EXPIRY — Postgres's JWT_EXP (seeding
        // app.settings.jwt_exp) and GoTrue's GOTRUE_JWT_EXP both read the same
        // already-overridden utils.Config.Auth.JwtExpiry in Go
        // (internal/db/start/start.go:68, internal/start/start.go:1372); using
        // the raw config value here would let Postgres and GoTrue disagree.
        jwtExpiry: values.authJwtExpiry,
        projectId,
        networkId,
        image: resolveImage(postgresImage),
        configImage: postgresImage,
        rootKey: values.rootKey,
      });
      yield* legacyStartContainer(spawner, postgresSpec, startOpts);
      // `dbHealthTimeoutSeconds` is resolved eagerly, before any Docker work — see its
      // definition above, alongside the other eagerly-validated config-override fields.
      // Watched by container name, matching Go's `utils.DbId`.
      const postgresHealthResult = yield* legacyWaitForHealthyServices(
        spawner,
        [postgresSpec.containerName],
        {
          timeoutSeconds: dbHealthTimeoutSeconds,
          images: new Map([[postgresSpec.containerName, postgresSpec.image]]),
        },
      ).pipe(Effect.result);
      if (Result.isFailure(postgresHealthResult)) {
        const error = postgresHealthResult.failure;
        if (flags.ignoreHealthCheck && legacyIsUnhealthyStartError(error)) {
          // Go's outer `Run()` check (`ignoreHealthCheck &&
          // IsUnhealthyError(err)`, `start.go:74-75`) applies uniformly to
          // whatever `run()` returns AS A WHOLE — including Postgres's own
          // health-wait error, which `run()` propagates immediately via
          // `StartDatabase`'s `if err != nil { return err }` (`start.go:
          // 294-296`), before any of the steps below (fresh-volume setup,
          // `initCurrentBranch`, every other service, the bulk health check)
          // ever run. Downgrade to a warning and short-circuit the rest of
          // this phase — matching Go's `Run()`, which prints the warning and
          // falls through to the SAME unconditional tail every other path
          // reaches (`start.go:84-87`), not an early return from the whole
          // command.
          yield* output.raw(`${legacyHealthWarningText(error)}\n`, "stderr");
          return { kind: "postgresUnhealthyIgnored" as const };
        }
        return yield* Effect.fail(error);
      }

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
            // start.go:270,299,321`), regardless of `--exclude` — resolve through
            // `legacyResolvePinnedImage` (not the raw Dockerfile default) so a
            // linked project's version pins apply here too. Resolved HERE, inside
            // this `isFreshVolume` block and additionally gated on `majorVersion
            // >= 15` (this schema-init path is PG15+-only, `db-setup.ts`'s own
            // `majorVersion <= 14` branch never reads `images`) — NOT pre-pulled
            // unconditionally up front, matching Go's own `ensureImagesCached`
            // (`start.go:237-262`), which only pre-pulls non-excluded services;
            // these images are resolved lazily inside `initSchema15` itself
            // (`DockerStart` -> `DockerResolveImageIfNotCached`,
            // `internal/utils/docker.go:363-365`), only when the job genuinely
            // runs. Still resolved through the SAME `projectEnvValues`-aware
            // `legacyEnsureImagesCached` used above (not the raw image string) so
            // a project-dotenv-only `SUPABASE_INTERNAL_IMAGE_REGISTRY` override
            // still applies whenever the job WILL run.
            const rawSetupJobImages = {
              realtime: legacyResolvePinnedImage("realtime", "realtime", serviceVersionOverrides),
              storage: legacyResolvePinnedImage("storage", "storage", serviceVersionOverrides),
              auth: legacyResolvePinnedImage("gotrue", "auth", serviceVersionOverrides),
            };
            const setupJobImagesToResolve =
              majorVersion >= 15
                ? [
                    ...(realtimeEnabledForSetup ? [rawSetupJobImages.realtime] : []),
                    ...(storageEnabledForSetup ? [rawSetupJobImages.storage] : []),
                    ...(authEnabledForSetup ? [rawSetupJobImages.auth] : []),
                  ]
                : [];
            const resolvedSetupJobImages =
              setupJobImagesToResolve.length > 0
                ? yield* legacyEnsureImagesCached(
                    spawner,
                    setupJobImagesToResolve,
                    projectEnvValues,
                  )
                : new Map<string, string>();
            const resolveSetupJobImage = (image: string) =>
              resolvedSetupJobImages.get(image) ?? image;
            const dbSetupImages: LegacyStartDbSetupImages = {
              realtime: resolveSetupJobImage(rawSetupJobImages.realtime),
              storage: resolveSetupJobImage(rawSetupJobImages.storage),
              auth: resolveSetupJobImage(rawSetupJobImages.auth),
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
              // excluded-services filtering even begins). Reuses
              // `{realtime,storage,auth}EnabledForSetup`, hoisted above (also
              // needed by `setupJobImages`) instead of recomputing them here.
              config: {
                ...config,
                realtime: {
                  ...config.realtime,
                  enabled: realtimeEnabledForSetup,
                  ip_version: realtimeIpVersion,
                  max_header_length: realtimeMaxHeaderLength,
                },
                storage: {
                  ...config.storage,
                  enabled: storageEnabledForSetup,
                  file_size_limit: storageFileSizeLimit,
                },
                auth: {
                  ...config.auth,
                  enabled: authEnabledForSetup,
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
              siteUrl: values.authSiteUrl,
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

      // Go's `started` slice, as an insertion-ordered container NAME -> resolved
      // image map. Go watches container names (`started = append(started,
      // utils.XxxId)`, `start.go:393-1267`), not the ids `docker create`
      // returns, so an unhealthy container reports as `supabase_auth_demo`
      // rather than 64 hex characters. Keying the images by that same name
      // keeps the watch list and its images from drifting apart.
      const started = new Map<string, string>();
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
          // `config.edge_runtime.secrets` is still schema-decoded plain
          // strings here — `toPlainEdgeRuntimeConfig` only emits entries
          // whose values are `Redacted` (`shared/functions/serve.ts`), and a
          // value only becomes `Redacted` after `resolveProjectSubtree`'s
          // env-interpolation + secret-path-redaction pass. Without this step
          // every configured `[edge_runtime.secrets]` entry is silently
          // dropped — `functions serve`'s own call site already resolves the
          // subtree first (`shared/functions/serve.ts:603-610`) before
          // calling the same helper.
          const resolvedEdgeRuntime = yield* resolveProjectSubtree(
            config.edge_runtime,
            { values: projectEnvValues ?? {} },
            "edge_runtime",
            { goViperCompat: true },
          );
          // Go's `DecryptSecretHookFunc` decode hook decrypts every `config.Secret`-typed field
          // (including `edge_runtime.secrets`) unconditionally during `Config.Load`, so the real
          // Edge Runtime container always receives plaintext. `toPlainEdgeRuntimeConfig` only
          // does `env()` interpolation and `Redacted`-unwrapping — it never decrypts a dotenvx
          // `encrypted:` value — so without this step the literal ciphertext would reach the
          // container's env file. `legacyCheckDbToml` (called unconditionally, before any Docker
          // work) already validates every `edge_runtime.secrets.*` entry is decryptable via
          // `legacyAssertDecryptableSecrets`, but only for that validation's own side effect — the
          // decrypted plaintext is discarded there, not threaded back into this value.
          const rawEdgeRuntimeSecrets = toPlainEdgeRuntimeConfig(resolvedEdgeRuntime).secrets;
          const dotenvPrivateKeys = legacyCollectDotenvPrivateKeys({
            ...projectEnvValues,
            ...process.env,
          });
          const edgeRuntimeSecrets: Record<string, string> = {};
          for (const [secretName, secretValue] of Object.entries(rawEdgeRuntimeSecrets)) {
            if (!legacyIsEncryptedSecret(secretValue)) {
              edgeRuntimeSecrets[secretName] = secretValue;
              continue;
            }
            const decrypted = legacyDecryptSecret(secretValue, dotenvPrivateKeys);
            if (!decrypted.ok) {
              return yield* Effect.fail(
                new LegacyStartInvalidConfigError({
                  message: `failed to parse config: ${decrypted.error}`,
                }),
              );
            }
            edgeRuntimeSecrets[secretName] = decrypted.value;
          }
          // `edgeRuntimePolicy`/`edgeRuntimeInspectorPort` are resolved eagerly, before any
          // Docker work — see their hoisted `wrapConfigOverride` calls next to
          // `dbHealthTimeoutSeconds` above.
          const edgeRuntimeInput: LegacyEdgeRuntimeBringUpInput = {
            projectId,
            networkId,
            image: resolveImage(edgeRuntimeDefaultImage),
            workdir: cliConfig.workdir,
            dbUrl: values.dbUrl,
            apiPort: values.apiPort,
            edgeRuntimePolicy,
            edgeRuntimeInspectorPort,
            edgeRuntimeSecrets,
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
          // `edge-runtime.service.ts`'s header for why. Unlike every other
          // service built here (`legacyStartContainer`'s `restartPolicy:
          // "unless-stopped"`), Go's own Edge Runtime bring-up sets no Docker
          // restart policy at all, so this container's `docker run` matches
          // that — but its bind-mounted host temp files must still exist for
          // as long as the container can be reattached to; `legacyStart
          // EdgeRuntimeContainer` already runs `cleanup` on a failed or
          // interrupted bring-up internally, so only the success path must
          // leave it alone.
          started.set(runtime.containerId, edgeRuntimeInput.image);
          edgeRuntimeGateway = {
            containerId: runtime.containerId,
            apiExternalUrl: values.apiUrl,
            secretKey: values.secretKey,
          };
          continue;
        }

        const image = imagePlanByService.get(entry.service);
        if (image === undefined) continue;

        // Several service builders do synchronous, throwing work over config.toml string fields
        // `@supabase/config`'s schema does not itself validate as durations/sizes (GoTrue's
        // `auth.email/sms.max_frequency`/sessions/mfa Go-duration parsing and Storage's
        // file-size-limit parsing are now caught earlier, eagerly, before any Docker work — see
        // the `resolvedEmail`/`storageFileSizeLimit` validation above — but this `catchDefect`
        // stays as defense-in-depth for any other field of this shape). A malformed value would
        // otherwise surface as an uncaught Effect defect — `Effect.onError` below still rolls back
        // on a defect either way, but the user would see an opaque defect instead of a typed
        // config error. `catchDefect` converts any such throw into the same typed config error
        // every other malformed-config path in this handler already produces, matching Go's
        // fail-at-config-decode behavior (Go's `time.Duration`/size fields fail at TOML decode,
        // before any Docker work starts).
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
        yield* legacyStartContainer(spawner, spec, startOpts);
        if (excludeFromHealthWatch !== true) {
          started.set(spec.containerName, spec.image);
        }
        if (entry.service === "postgrest") {
          postgrestGateway = {
            containerId: spec.containerName,
            apiExternalUrl: values.apiUrl,
            secretKey: values.secretKey,
          };
        }
        if (entry.service === "storage") {
          storageContainerId = spec.containerName;
        }
      }

      return {
        kind: "started" as const,
        started,
        postgrestGateway,
        edgeRuntimeGateway,
        storageContainerId,
      };
    }).pipe(
      // Go's `DockerRemoveAll`'s real `utils.NoBackupVolume` value
      // (`docker.go:94,126`) — `true` only when this run's Postgres volume was
      // freshly created (see `isFreshVolume` above), matching Go exactly: a
      // rollback prunes volumes on a brand-new, empty first-ever `start`, but
      // never touches a pre-existing user's data on a failed restart.
      //
      // `Effect.onError`, not `Effect.tapError`: Go's own `Run()` (`start.go:73-82`)
      // rolls back on ANY non-nil error from `run()`, including `context.Canceled`
      // from a SIGINT during bring-up (`cmd/root.go:99,155` wraps every command's
      // context with `signal.NotifyContext`). `tapError` is built on `Cause.findError`,
      // which only matches `Fail` reasons — a pure fiber interrupt never reaches it.
      // `onError` fires on any failure outcome (including interruption) and its
      // cleanup effect runs uninterruptibly, matching Go's unconditional check.
      Effect.onError(() =>
        legacyRollbackStart(spawner, filterValue, isFreshVolume, cliConfig.workdir, debug),
      ),
    );

    if (shouldRecoverStoppedStack) {
      // Recheck after preflight in case Docker or another process restarted the stack.
      const recheckedState = yield* inspectDbState;
      if (recheckedState !== undefined && !isRecoverableStoppedState(recheckedState)) {
        return yield* reportAlreadyRunningStatus();
      }
      // legacyCliProjectFilterValue("") targets every CLI-managed project; never use it here.
      if (projectId.length === 0) {
        return yield* Effect.fail(
          new LegacyStartInvalidConfigError({
            message: "Invalid config: project_id must contain at least one alphanumeric character.",
          }),
        );
      }
      let removedContainers: ReadonlyArray<LegacyContainerIdName> = [];
      yield* legacyDockerRemoveAll(
        spawner,
        filterValue,
        false,
        (containers) => {
          // Recovery only trusts its own workdir; empty labels use the existing fallback.
          removedContainers = containers.filter(
            (container) =>
              container.workdir.length === 0 || container.workdir === cliConfig.workdir,
          );
        },
        debug,
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() => legacyCleanupStartSecrets(removedContainers, cliConfig.workdir)),
        ),
      );
    }

    const bringUpResult = yield* bringUp;

    // Only reached when Postgres itself became healthy (or the volume already
    // existed) — the `postgresUnhealthyIgnored` short-circuit above skips this
    // entire block, matching Go's `Run()`, which falls through to the tail
    // below either way but never re-enters `run()`'s later steps once
    // `StartDatabase` has already returned.
    if (bringUpResult.kind === "started") {
      const { started, postgrestGateway, edgeRuntimeGateway, storageContainerId } = bringUpResult;

      // Wraps steps 9-11 below (bulk health wait, the ignore-health-check
      // storage-only recheck-and-seed, the success-path bucket seeding, and
      // the `cli_stack_started` capture) in the same `Effect.onError` rollback
      // `bringUp`'s own pipe uses above. Go's `run()` keeps this entire tail in
      // the SAME function body as bring-up (`start.go:264-1288`), and `Run()`
      // checks `run()`'s one returned error exactly once (`start.go:73-81`) —
      // a SIGINT/SIGTERM landing anywhere in this tail, not just during
      // bring-up, must roll back too. Per-step manual `legacyRollbackStart`
      // calls would miss a pure fiber interrupt between steps (see the
      // `bringUp` pipe's doc comment for why `onError`, not `tapError`, is
      // required), so every fail path below just fails and lets this single
      // outer `onError` roll back.
      yield* Effect.gen(function* () {
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
        // Folds the hoisted, env-overridden `apiEnabled`/`apiPort`/`apiTlsEnabled`/
        // `apiTlsCertPath`/`apiTlsKeyPath`/`values.apiUrl` into `config` (not the
        // raw values) so a `SUPABASE_API_ENABLED`/`SUPABASE_API_PORT`/
        // `SUPABASE_API_TLS_{ENABLED,CERT_PATH,KEY_PATH}`/`SUPABASE_API_EXTERNAL_URL`
        // override that actually brought Kong up on a different port/TLS/cert/
        // external URL also reaches every local Storage-gateway caller below —
        // otherwise `resolveLocalBaseUrl` derives its URL from the un-overridden
        // `config.api.{port,tls.enabled,external_url}` and points at a
        // port/scheme/host nothing is actually listening on, and
        // `validateLocalKongTls`'s own `opts.config.api.enabled &&
        // opts.config.api.tls.enabled` gate (`legacy-storage-credentials.ts`)
        // validates against a cert/key path Kong itself isn't actually serving
        // from when `api.enabled` disagrees with the raw config (Kong's own spec
        // uses these same resolved `apiEnabled`/`apiTlsCertPath`/`apiTlsKeyPath`
        // locals). Also folds in the
        // already-resolved `values.jwtSecret`/`values.serviceRoleKey` (decrypted,
        // env/dotenv-overridden — the same values the real GoTrue/Storage containers
        // were started with) instead of the raw `config.auth.*`
        // `legacyResolveStorageCredentials`'s local branch would otherwise
        // re-derive from a narrower, dotenv-blind `process.env`-only check —
        // mirroring Go's single `utils.Config.Auth.*.Value`/`Api.ExternalUrl` read
        // by both the container env and `newLocalClient` (`internal/storage/
        // client/api.go:30-37`). Also folds in `storageFileSizeLimit`/
        // `storageVectorEnabled` so `legacySeedBucketsRun` (which reads
        // `config.storage.file_size_limit`/`config.storage.vector.enabled` to fill
        // bucket defaults and gate vector-upsert seeding, `legacy-seed-buckets.ts`)
        // sees the same values the real Storage container was started with, not the
        // raw un-overridden config — mirroring Go's `internal/seed/buckets/
        // buckets.go:54` and `pkg/config/config.go:919-920`, both reading the
        // single `utils.Config.Storage.{FileSizeLimit,VectorBuckets.Enabled}`.
        // Reused for both this health-check CA lookup and the two
        // `legacySeedBucketsRun` calls below (`resolvedConfig`), so bucket
        // seeding never independently reloads config.toml and silently drops
        // these same overrides — mirroring Go's `buckets.Run` reading the single
        // process-wide `utils.Config` instead of reloading.
        const effectiveLocalStorageConfig = {
          ...config,
          api: {
            ...config.api,
            enabled: apiEnabled,
            port: values.apiPort,
            external_url: values.apiUrl,
            tls: {
              ...config.api.tls,
              enabled: apiTlsEnabled,
              cert_path: apiTlsCertPath,
              key_path: apiTlsKeyPath,
            },
          },
          auth: {
            ...config.auth,
            jwt_secret: values.jwtSecret,
            service_role_key: values.serviceRoleKey,
          },
          storage: {
            ...config.storage,
            file_size_limit: storageFileSizeLimit,
            vector: {
              ...config.storage.vector,
              enabled: storageVectorEnabled,
            },
          },
        };
        const { localKongCa } = yield* legacyResolveStorageCredentials({
          projectRef: "",
          config: effectiveLocalStorageConfig,
        });
        const healthResult = yield* legacyWaitForHealthyServices(spawner, [...started.keys()], {
          postgrest: postgrestGateway,
          edgeRuntime: edgeRuntimeGateway,
          images: started,
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
              // `images` is intentionally the whole run's registry, not scoped to
              // this one-container watch list — the hint can only ever key off
              // containers that actually appear in this call's own failures.
              const storageHealthResult = yield* legacyWaitForHealthyServices(
                spawner,
                [storageContainerId],
                { images: started },
              ).pipe(Effect.result);
              if (Result.isSuccess(storageHealthResult)) {
                const seedResult = yield* legacySeedBucketsRun({
                  projectRef: "",
                  emitSummary: false,
                  interactive: false,
                  yes: true,
                  resolvedConfig: {
                    config: effectiveLocalStorageConfig,
                    document: context.loaded?.document,
                  },
                }).pipe(Effect.result);
                if (Result.isFailure(seedResult)) {
                  // No manual `legacyRollbackStart` here — the outer
                  // `Effect.onError` below rolls back on this failure too.
                  return yield* Effect.fail(seedResult.failure);
                }
              }
            }
            // Downgrade to a warning and fall through to the success path, no rollback.
            yield* output.raw(`${legacyHealthWarningText(error)}\n`, "stderr");
          } else {
            // No manual `legacyRollbackStart` here — the outer `Effect.onError`
            // below rolls back on this failure too.
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
        // rolls back via the same outer `Effect.onError` as everything else in
        // this tail: Go's top-level `Run()` (`start.go:73-81`) wraps `run()`'s
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
            resolvedConfig: {
              config: effectiveLocalStorageConfig,
              document: context.loaded?.document,
            },
          });
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
      }).pipe(
        Effect.onError(() =>
          legacyRollbackStart(spawner, filterValue, isFreshVolume, cliConfig.workdir, debug),
        ),
      );
    }

    // Go's `status.PrettyPrint(os.Stdout, excludedContainers...)` (`start.go:85`)
    // trusts "config-enabled + not --exclude'd" as a proxy for "actually
    // running" — true whenever `run()` reaches this line normally (it would
    // have already failed and rolled back before getting here if any enabled,
    // non-excluded container's `DockerStart` failed). The one exception, in Go
    // and here alike: an IGNORED Postgres health-check timeout
    // (`bringUpResult.kind === "postgresUnhealthyIgnored"` above) reaches this
    // same tail via the SAME fallthrough Go's `Run()` uses (`start.go:74-87`)
    // even though every OTHER enabled, non-excluded container was never even
    // created — `status.PrettyPrint`/`buildStatusValues` render them anyway,
    // purely from config, with no Docker query to contradict it. Edge Runtime
    // now genuinely starts under that same "config-enabled" gate (no more
    // force-exclusion from status rendering), so the raw `--exclude` values
    // are enough on their own.
    const statusExcluded = flags.exclude;

    if (output.format === "text") {
      yield* output.raw(legacyStartCompletedMessage(), "stderr");
      // Called DIRECTLY, unlike the already-running branch's `status.Run`: no
      // re-health-check, no "stopped services" diffing, just the raw
      // `--exclude` values against the config/values already resolved (and
      // just health-checked) above. `values` is passed through as
      // `precomputedLocal` so this reuses the exact keys already baked into
      // the containers `bringUp` just created, instead of re-deriving them.
      const { values: statusValues, names } = yield* buildStatusValues(statusExcluded, values);
      yield* output.raw(legacyRenderStatusPretty(statusValues, names));
      yield* output.raw(legacyStartSecurityNotice(), "stderr");
    } else {
      const { values: statusValues } = yield* buildStatusValues(statusExcluded, values);
      yield* output.success("", statusValues);
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});

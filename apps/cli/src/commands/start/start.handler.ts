/**
 * Native TS implementation of `start` — see `SIDE_EFFECTS.md` for the full
 * behavior contract.
 */
import { readFileSync } from "node:fs";
import { inferFunctionsManifest } from "@supabase/config/effect";
import { resolveCliConfigSubtree } from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CLI_VERSION } from "../../shared/cli/version.ts";
import { rawFunctionConfigRecord } from "../../shared/functions/deploy.ts";
import {
  resolveFunctionBindMounts,
  toPlainEdgeRuntimeConfig,
  toPlainFunctionRecord,
  type StartedRuntime,
} from "../../shared/functions/serve.ts";
import {
  DebugFlag,
  NetworkIdFlag,
  resolveExperimentalWithProjectEnv,
} from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { EventStackStarted } from "../../shared/telemetry/event-catalog.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { resolveStudioApiUrl } from "../../command-internal/api-url.ts";
import { isBitbucketPipeline } from "../../command-internal/bitbucket-pipeline.ts";
import { aqua, yellow } from "../../command-internal/colors.ts";
import {
  apiTlsCertReadErrorMessage,
  apiTlsKeyReadErrorMessage,
  emailContentPathReadErrorMessage,
  resolveApiTlsPath,
  resolveEmailTemplateContentPath,
} from "../../command-internal/config-validate.ts";
import { isContainerNotFoundMessage } from "../../command-internal/container-cli.ts";
import { checkDbToml } from "../../command-internal/db-config.toml-read.ts";
import { resolveEdgeRuntimeImage } from "../../command-internal/edge-runtime-image.ts";
import {
  resolveStorageCredentials,
  storageGatewayFetch,
} from "../../command-internal/storage-credentials.ts";
import {
  collectDotenvPrivateKeys,
  decryptSecret,
  isEncryptedSecret,
} from "../../command-internal/vault-decrypt.ts";
import { parseGoDuration } from "../../command-internal/go-duration.ts";
import { configureLoopbackProxyBypass } from "../../command-internal/hostname.ts";
import {
  cliProjectFilterValue,
  serviceContainerIds,
  serviceContainerName,
  localDbContainerId,
} from "../../command-internal/docker-ids.ts";
import { resolveDockerNetworkMode } from "../../shared/functions/functions-docker.ts";
import { viperEnvStringWithProjectFallback } from "../../command-internal/viper-env.ts";
import {
  inspectContainerState,
  listContainersByLabel,
  type ContainerIdName,
} from "../../command-internal/docker-lifecycle.ts";
import { dockerRemoveAll } from "../../command-internal/docker-remove-all.ts";
import {
  envOverride,
  envOverrideApiMaxRows,
  envOverrideBool,
  envOverrideDefaultPoolSize,
  envOverrideDenoVersion,
  envOverrideEdgeRuntimePolicy,
  envOverrideMaxClientConn,
  envOverridePoolMode,
  envOverridePort,
  envOverrideUint,
  resolveAuthCaptcha,
  resolveAuthEmail,
  resolveAuthEmailSmtp,
  resolveAuthExternalProviders,
  resolveAuthHooks,
  resolveAuthMfa,
  resolveAuthSms,
  resolveConfiguredSigningKeys,
  resolveAuthExternalUrl,
  resolveDbSettingsEnvOverrides,
  resolveGotrueOAuthServer,
  resolveGotruePasskeyWebauthn,
  resolveGotrueRateLimit,
  resolveGotrueSessions,
  resolveGotrueWeb3,
  resolveLocalConfigValues,
  resolveLocalJwks,
  resolveThirdPartyProviders,
  type LocalConfigValues,
  type ResolvedAuthEmail,
} from "../../command-internal/local-config-values.ts";
import {
  loadLocalProjectContext,
  type LocalProjectContext,
} from "../../command-internal/local-project-context.ts";
import { seedBucketsRun } from "../../command-internal/seed-buckets.ts";
import { cleanupStartSecrets } from "../../command-internal/start-secrets-cleanup.ts";
import {
  StatusDbInspectError,
  StatusDbNotReadyError,
  StatusDbNotRunningError,
  StatusInvalidConfigError,
  StatusListError,
} from "../../command-internal/status-errors.ts";
import { renderStatusPretty } from "../../command-internal/status-pretty.ts";
import {
  gateStatusState,
  resolveStatusLocalState,
  statusContainerIds,
  statusValuesFromState,
} from "../../command-internal/status-values.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import type { StartFlags } from "./start.command.ts";
import {
  StartConfigLoadError,
  StartInvalidConfigError,
  StartWorkdirError,
} from "./start.errors.ts";
import { partitionStartExcludeFlags } from "./start.exclude.ts";
import {
  startAlreadyRunningMessage,
  startCompletedMessage,
  startSecurityNotice,
  START_STARTING_CONTAINERS_MESSAGE,
  START_WAITING_FOR_HEALTH_CHECKS_MESSAGE,
} from "./start.format.ts";
import { resolveStartGates, resolveStartImagePlan } from "./start.gates.ts";
import {
  isUnhealthyStartError,
  rollbackStart,
} from "../../command-internal/db-bootstrap/rollback.ts";
import { resolveDbBootstrapConfig } from "../../command-internal/db-bootstrap/bootstrap-config.ts";
import { startDatabase } from "../../command-internal/db-bootstrap/start-database.ts";
import { START_SERVICES } from "./start.services.ts";
import {
  createContainer,
  type ContainerOpts,
} from "../../command-internal/db-bootstrap/container-lifecycle.ts";
import { ensureImagesCached } from "../../command-internal/db-bootstrap/image-prepull.ts";
import {
  waitForHealthyServices,
  type HealthCheckPostgrestGateway,
  type HealthCheckTimeoutError,
} from "../../command-internal/db-bootstrap/health-check.ts";
import {
  startInternalDbPassword,
  START_INTERNAL_DB_NAME,
  START_INTERNAL_DB_PORT,
} from "../../command-internal/db-bootstrap/internal-db-connection.ts";
import { KONG_LOCAL_TLS_CERT, KONG_LOCAL_TLS_KEY } from "./templates/kong-local-tls.ts";
import { buildLogflareContainerSpec } from "./services/logflare.service.ts";
import {
  buildVectorContainerSpec,
  resolveDockerDaemonHost,
  resolveVectorDockerSocketPlan,
} from "./services/vector.service.ts";
import {
  buildKongContainerSpec,
  resolveKongNginxWorkerProcesses,
  type KongEmailTemplateMount,
} from "./services/kong.service.ts";
import {
  startStackEdgeRuntimeContainer,
  type EdgeRuntimeBringUpInput,
} from "./services/edge-runtime.service.ts";
import { buildGotrueContainerSpec, type BuildGotrueEnvInput } from "./services/gotrue.service.ts";
import { buildMailpitContainerSpec } from "./services/mailpit.service.ts";
import { buildRealtimeContainerSpec } from "./services/realtime.service.ts";
import { REALTIME_TENANT_ID } from "../../command-internal/db-bootstrap/realtime-env.ts";
import { buildPostgrestContainerSpec } from "./services/postgrest.service.ts";
import { buildStorageContainerSpec } from "./services/storage.service.ts";
import { buildImgproxyContainerSpec } from "./services/imgproxy.service.ts";
import { buildPgMetaContainerSpec } from "./services/pg-meta.service.ts";
import { buildStudioContainerSpec } from "./services/studio.service.ts";
import { buildSupavisorContainerSpec } from "./services/supavisor.service.ts";

/**
 * The analytics API key's only possible value — never configurable.
 * Duplicated locally rather than hoisted: `logflare.service.ts`/
 * `studio.service.ts` each already hardcode this same literal independently,
 * matching that existing precedent instead of introducing a new shared
 * constant for it.
 */
const ANALYTICS_API_KEY = "api-key";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps a synchronous `envOverride*`/`envOverride*` config-override read that throws on a
 * malformed value into a typed `StartInvalidConfigError` failure —
 * config validation hard-fails on a bad decode before any Docker work runs —
 * instead of leaking an untyped Effect defect that bypasses
 * `withJsonErrorHandling`'s `Effect.catch` (which, unlike this pipeline's `Effect.onError`
 * rollback, only intercepts typed failures, never defects).
 */
function wrapConfigOverride<T>(
  dottedFieldPath: string,
  thunk: () => T,
): Effect.Effect<T, StartInvalidConfigError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      new StartInvalidConfigError({
        message: `invalid config for ${dottedFieldPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

/**
 * Every value {@link buildGotrueContainerSpec} needs from `config`/
 * `values`, minus `dbHost`/`dbPassword` (which that builder derives itself
 * from `projectId`/`dbUrl`). See this module's header for the `@supabase/
 * config` schema gaps (`captcha`/`passkey`/`webauthn`/`email.smtp` presence,
 * `external` provider filtering) `gotrue.service.ts`'s own doc comment
 * documents — reused here.
 *
 * A configured `auth.signing_keys_path` is honored for anon/service_role JWT
 * SIGNING (`values.jwtSecret`/`resolveLocalConfigValues`'s own
 * `loadFirstSigningKey`), for the stack-wide JWKS document
 * (`resolveLocalJwks`), AND here as GoTrue's own `GOTRUE_JWT_KEYS` —
 * all three resolve the SAME file via
 * {@link resolveConfiguredSigningKeys}, so GoTrue always signs with
 * (one of) the key(s) the published JWKS advertises. `undefined` (the
 * default ES256 key, matching `gotrue.service.ts`'s hardcoded
 * `GOTRUE_DEFAULT_SIGNING_KEY`) only when no `signing_keys_path` is
 * configured or auth is disabled.
 */

function resolveGotrueEnvInput(params: {
  readonly context: LocalProjectContext;
  readonly values: LocalConfigValues;
  readonly workdir: string;
  readonly kongContainerName: string;
  readonly mailpitContainerName: string;
  readonly resolvedEmail: ResolvedAuthEmail;
}): Omit<BuildGotrueEnvInput, "dbHost" | "dbPassword"> {
  const { context, values, workdir, kongContainerName, mailpitContainerName, resolvedEmail } =
    params;
  const { config, projectEnvValues, loaded } = context;
  const document = loaded?.document;

  const inbucketEnabled = envOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  // `[auth.email.smtp]`'s presence-based `enabled` default — reading the
  // schema-decoded `config.auth.email.smtp` here would always see `enabled:
  // false` when the key is merely absent from the TOML table (`@supabase/
  // config`'s decode-time default), silently falling back to Mailpit even
  // when a real SMTP server is configured. `resolveAuthEmailSmtp`
  // resolves this correctly off the raw document, same as the passkey/
  // webauthn/external-provider reads below.
  const resolvedSmtp = resolveAuthEmailSmtp(asRecord(document?.["auth"]), projectEnvValues);
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
  const mailpitAdminEmail = envOverride(
    "SUPABASE_LOCAL_SMTP_ADMIN_EMAIL",
    config.local_smtp.admin_email,
    projectEnvValues,
  );
  const mailpitSenderName = envOverride(
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
  const externalProviders = resolveAuthExternalProviders(
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
    sms: resolveAuthSms(asRecord(document?.["auth"]), config.auth.sms, projectEnvValues),
    sessions: resolveGotrueSessions(config.auth.sessions, projectEnvValues),
    mfa: resolveAuthMfa(config.auth.mfa, projectEnvValues),
    rateLimit: resolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
    web3: resolveGotrueWeb3(config.auth.web3, projectEnvValues),
    oauthServer: resolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
    hooks: resolveAuthHooks(asRecord(document?.["auth"]), config.auth.hook, projectEnvValues),
    captcha: resolveAuthCaptcha(
      asRecord(document?.["auth"]),
      config.auth.captcha,
      projectEnvValues,
    ),
    passkeyEnabled,
    webauthn,
    externalProviders,
    signingKeys: resolveConfiguredSigningKeys(config, workdir, projectEnvValues),
  };
}

/**
 * Read-and-discard existence/readability check for one already-resolved
 * `content_path` — same pattern as `local-config-values.ts`'s
 * `readAuthEmailTemplateContent` and `push.auth-email-content.ts`'s
 * `readTemplateContent`, reusing their established error message shape.
 * Closes the gap where a resolved-but-never-read path (e.g. a `content_path`
 * naming a missing file, only reachable when `auth.enabled = false`) would
 * otherwise reach Docker unverified — the root-privileged daemon silently
 * creates a directory at a bind-mounted host path that doesn't exist, so an
 * unprivileged read here must succeed first.
 */
function readKongEmailTemplateContent(
  section: "template" | "notification",
  name: string,
  resolvedPath: string,
): void {
  try {
    readFileSync(resolvedPath, "utf8");
  } catch (cause) {
    throw new Error(emailContentPathReadErrorMessage(section, name, cause));
  }
}

/**
 * Kong's email template mounts: every configured template, then every
 * ENABLED notification, suffixed `_notification`. Resolves, containment-
 * checks, and read-verifies each `content_path` HERE — once, before any
 * Docker work — via `resolveEmailTemplateContentPath` (the same check
 * config validation and `config push` apply) followed by
 * `readKongEmailTemplateContent`. The resulting `resolvedPath` is what the
 * caller threads straight into `buildKongEmailTemplateBind`; nothing
 * re-derives it later, right before the `docker create` call for Kong
 * (potentially minutes later, after image pulls/Postgres bring-up/
 * migrations) — closing the TOCTOU window between an earlier
 * validation-only pass and Kong's own independent re-resolution.
 *
 * Skips (never throws for) an entry whose resolver returns `undefined` — per
 * its own contract that only happens for an empty/absent `content_path`,
 * which should be unreachable here since Kong's set is built from configured
 * entries, but this omits the mount defensively rather than crashing.
 */
function resolveKongEmailTemplateMounts(
  email: ResolvedAuthEmail,
  workdir: string,
): ReadonlyArray<KongEmailTemplateMount> {
  const mounts: Array<KongEmailTemplateMount> = [];
  for (const [id, template] of Object.entries(email.template)) {
    const resolvedPath = resolveEmailTemplateContentPath({
      section: "template",
      name: id,
      contentPath: template.content_path,
      contentPresent: false,
      base: workdir,
    });
    if (resolvedPath === undefined) continue;
    readKongEmailTemplateContent("template", id, resolvedPath);
    mounts.push({ id, resolvedPath });
  }
  for (const [id, notification] of Object.entries(email.notification)) {
    if (!notification.enabled) continue;
    const resolvedPath = resolveEmailTemplateContentPath({
      section: "notification",
      name: id,
      contentPath: notification.content_path,
      contentPresent: false,
      base: workdir,
    });
    if (resolvedPath === undefined) continue;
    readKongEmailTemplateContent("notification", id, resolvedPath);
    mounts.push({ id: `${id}_notification`, resolvedPath, notification: true });
  }
  return mounts;
}

/**
 * What `--ignore-health-check` prints when it downgrades a health-check timeout
 * to a warning. That decision belongs to this caller, not `../../shared/db-bootstrap/health-check.ts`
 * (which only implements the polling contract), and it writes straight to
 * stderr — bypassing the `Output.fail` renderer that would otherwise append the
 * error's `suggestion` for it.
 */
function healthWarningText(error: HealthCheckTimeoutError): string {
  return error.suggestion === undefined ? error.message : `${error.message}\n${error.suggestion}`;
}

export const start = Effect.fn("start")(function* (flags: StartFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const analytics = yield* Analytics;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  // Threaded into every `dockerRemoveAll` teardown below — `--debug`
  // gates that function's `Pruned …:` stderr reports.
  const debug = yield* DebugFlag;

  yield* Effect.gen(function* () {
    // 0. Change into the resolved workdir — unconditional, before `start`'s
    // own flag validation (see step 1).
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new StartWorkdirError({ message: error.message })),
    );

    // 1. `--exclude` validation runs as the VERY FIRST step — before config
    // loads or checking whether the stack is already running, so this
    // warning fires unconditionally on every invocation with an invalid
    // `--exclude` value, including the already-running short-circuit below.
    // `excludedKeys` (the VALID subset) is what actually gates container
    // bring-up later.
    const partition = partitionStartExcludeFlags(flags.exclude);
    if (partition.warning !== undefined && output.format === "text") {
      yield* output.raw(partition.warning, "stderr");
    }
    const excludedKeys = new Set(partition.valid);

    // 2. Config load + validate — same config-load/env/project-id
    // resolution sequence as `stop`/`status`.
    const context = yield* loadLocalProjectContext(
      cliSettings.workdir,
      (message) => new StartConfigLoadError({ message }),
    );
    const values = yield* Effect.try({
      try: () =>
        resolveLocalConfigValues(
          context.config,
          context.hostname,
          cliSettings.workdir,
          context.projectEnvValues,
          context.loaded?.document,
        ),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const { config, projectId, projectEnvValues } = context;
    // `SUPABASE_EXPERIMENTAL`/`--experimental`, read deep inside
    // `startDatabase`'s fresh-volume setup pipeline — resolved here
    // (project `.env` aware, like `db reset`'s identical gate) so it can be
    // threaded straight through to `startDatabase`'s own
    // `setup.experimental` below.
    const experimental = yield* resolveExperimentalWithProjectEnv(projectEnvValues);
    // Single source resolved once, fed to both Kong's template mounts and GoTrue's env builder —
    // see {@link resolveAuthEmail}'s doc comment.
    const resolvedEmail = yield* Effect.try({
      try: () =>
        resolveAuthEmail(
          config.auth.email,
          asRecord(context.loaded?.document?.["auth"]),
          projectEnvValues,
        ),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    // Kong mounts every configured template (regardless of `auth.enabled` —
    // Kong is the stack's mandatory gateway) and every ENABLED notification's
    // `content_path`, unconditionally. Resolving, containment-checking, AND
    // read-verifying every path happens exactly ONCE, here, before any Docker
    // work — not only inside `resolveLocalConfigValues`'s own
    // `auth.enabled`-gated `readAuthEmailTemplateContent` call. The resulting
    // `resolvedPath`s are threaded straight into the Kong container-spec
    // input below instead of being discarded and re-derived later inside
    // `buildKongEmailTemplateBind`, which closes the TOCTOU window
    // between this pass and Kong's `docker create` call (potentially minutes
    // later, after image pulls/Postgres bring-up/migrations).
    const kongEmailTemplateMounts = yield* Effect.try({
      try: () => resolveKongEmailTemplateMounts(resolvedEmail, cliSettings.workdir),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    // Every `time.Duration`-shaped config field — including these 5 — must
    // fail fast, before `start` touches Docker at all: these fields are only
    // parsed inside GoTrue's own env builder (`gotrue.service.ts`), which
    // never runs at all when auth is disabled or `gotrue` is excluded — so a
    // malformed value would otherwise be silently accepted instead of
    // failing the command. Validate eagerly here, discarding the parsed
    // nanosecond counts, since `resolveGotrueEnvInput` (below) re-resolves
    // and re-parses these same fields for the actual GoTrue container
    // build.
    const gotrueSessionsForValidation = resolveGotrueSessions(
      config.auth.sessions,
      projectEnvValues,
    );
    yield* wrapConfigOverride("auth.email.max_frequency", () =>
      parseGoDuration(resolvedEmail.max_frequency),
    );
    // Wrapped like `resolvedEmail` above: `resolveLocalConfigValues`'s own SMS validation
    // only runs `if (authEnabled)` (`local-config-values.ts`), so this direct call is the
    // ONLY place a malformed `auth.sms.*` override is ever caught when auth is disabled — an
    // unwrapped throw here would surface as an Effect defect instead of the normal
    // `StartInvalidConfigError` config-load failure.
    const smsForValidation = yield* Effect.try({
      try: () =>
        resolveAuthSms(
          asRecord(context.loaded?.document?.["auth"]),
          config.auth.sms,
          projectEnvValues,
        ),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    yield* wrapConfigOverride("auth.sms.max_frequency", () =>
      parseGoDuration(smsForValidation.max_frequency),
    );
    // SMS validation downgrades `EnableSignup` to `false` and prints a
    // warning when no provider is enabled — `resolveAuthSms` already
    // applies the downgrade itself, so this only needs to detect whether
    // that branch fired (the user configured `enable_signup = true` with
    // every provider disabled) to print the matching warning.
    if (
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
    if (gotrueSessionsForValidation?.timebox !== undefined) {
      yield* wrapConfigOverride("auth.sessions.timebox", () =>
        parseGoDuration(gotrueSessionsForValidation.timebox!),
      );
    }
    if (gotrueSessionsForValidation?.inactivity_timeout !== undefined) {
      yield* wrapConfigOverride("auth.sessions.inactivity_timeout", () =>
        parseGoDuration(gotrueSessionsForValidation.inactivity_timeout!),
      );
    }
    yield* wrapConfigOverride("auth.mfa.phone.max_frequency", () =>
      parseGoDuration(resolveAuthMfa(config.auth.mfa, projectEnvValues).phone.max_frequency),
    );
    // Same gap for the remaining GoTrue overrides: `auth.rate_limit.*` (plain `uint`s) and
    // `auth.web3.*.enabled`/`auth.oauth_server.{enabled,allow_dynamic_registration}` (plain
    // `bool`s) must all validate unconditionally, regardless of
    // `auth.enabled`/`--exclude gotrue`.
    // `resolveGotrueRateLimit`/`resolveGotrueWeb3`/`resolveGotrueOAuthServer` already
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
    // <name>.{enabled,skip_nonce_check,email_optional}` — these raw
    // (unmodeled by `@supabase/config`) booleans must validate
    // unconditionally too, regardless of `auth.enabled`/`--exclude gotrue`.
    // Both resolvers already throw internally on a bad raw bool (`rawUnmodeledBool`)
    // and are otherwise only reached from `resolveGotrueEnvInput`'s `case "gotrue":` branch below —
    // itself gated on auth being enabled and gotrue not excluded — so calling each here, once,
    // eagerly and discarding the result, closes the same "validates but doesn't reach it" gap.
    yield* wrapConfigOverride("auth.passkey", () =>
      resolveGotruePasskeyWebauthn(context.loaded?.document, projectEnvValues),
    );
    yield* wrapConfigOverride("auth.external", () =>
      resolveAuthExternalProviders(
        asRecord(context.loaded?.document?.["auth"]),
        config.auth.external,
        projectEnvValues,
      ),
    );
    // Same gap for `auth.third_party.<provider>.{enabled,...}` — this must
    // validate unconditionally regardless of `auth.enabled`, even though
    // validation itself is otherwise only meaningful when auth is enabled.
    // `resolveThirdPartyProviders` is otherwise never called by this
    // handler at all (GoTrue's own container build never wires third-party
    // JWT settings) — so a malformed override (e.g.
    // `SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED=bogus`) would otherwise
    // never fail this command at all (review: PRRT_kwDOErm0O86WXFqj).
    yield* wrapConfigOverride("auth.third_party", () =>
      resolveThirdPartyProviders(config.auth.third_party, projectEnvValues),
    );
    // `[functions.<slug>.env]` has no supported meaning for `start` — this
    // must reject any unknown key unconditionally, well before any Docker
    // work, matching the established config-validation contract.
    // `@supabase/config`'s own schema DOES model `[functions.<slug>.env]`
    // (`packages/config/src/functions.ts`) — a legitimate schema feature the
    // shared package keeps for other consumers — so this is a CLI-side
    // rejection, not a schema change. Confirmed against the
    // established parity contract: a config with `[functions.foo.env]`
    // fails with `'functions[foo]' has invalid keys: env`.
    for (const [slug, func] of Object.entries(config.functions)) {
      if (Object.keys(func.env).length > 0) {
        yield* Effect.fail(
          new StartInvalidConfigError({
            message: `failed to parse config: decoding failed due to the following error(s):\n\n'functions[${slug}]' has invalid keys: env`,
          }),
        );
      }
    }
    // `checkDbToml` resolves `[db.vault]`/`[db.seed]`/`db.migrations.enabled`/the effective
    // `api.auto_expose_new_tables` tri-state — this must run unconditionally,
    // before any Docker work. The port only ran this inside
    // `startSetupLocalDatabase`, which is itself gated on the DB container's
    // healthcheck passing AND a fresh volume (the `NoBackupVolume` gate) — so a malformed
    // `SUPABASE_DB_SEED_ENABLED`/an undecryptable `[db.vault]` secret went completely unvalidated
    // whenever `start` reused an existing volume. The resolved Webhooks flag is also retained so
    // existing volumes can converge `pg_net`; `startSetupLocalDatabase`'s own internal call
    // (an already-accepted duplicate config-load pass, matching `db start`'s own independent
    // resolution — see `../../shared/db-bootstrap/db-setup.ts`'s header) still resolves fresh-setup
    // values for its own use when it runs.
    const dbTomlValues = yield* checkDbToml(fs, path, cliSettings.workdir);

    const dbContainerId = localDbContainerId(projectId);
    const filterValue = cliProjectFilterValue(projectId);

    // Shared status-values helper — reused by BOTH the already-running branch
    // (full status pipeline, health-checked + "stopped" diffed) and the
    // success path at the end (a direct pretty-print/`toValues` call, no
    // re-health-check — see each call site's own comment for why they
    // differ).
    //
    // `precomputedLocal` is only ever passed by the success-path call: the
    // already-running branch delegates to the shared status pipeline, which
    // loads config (and therefore re-derives keys) a SECOND time in that
    // same process, so recomputing here matches that. The success path, by
    // contrast, never reloads config again after bring-up — it prints
    // straight from the already-populated config — so it must reuse the
    // SAME `values` that were already used to build every container spec,
    // instead of re-deriving (and, for asymmetric JWTs, re-signing with a
    // new `exp`) a second time. See {@link resolveStatusLocalState}'s
    // `precomputedLocal` param doc for why a second derivation is unsafe.
    const buildStatusValues = Effect.fnUntraced(function* (
      excluded: ReadonlyArray<string>,
      precomputedLocal?: LocalConfigValues,
    ) {
      const localState = yield* Effect.try({
        try: () =>
          resolveStatusLocalState(
            context.config,
            context.hostname,
            cliSettings.workdir,
            context.projectEnvValues,
            context.loaded?.document,
            precomputedLocal,
          ),
        catch: (cause) =>
          new StatusInvalidConfigError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const containerIds = statusContainerIds(projectId);
      const state = gateStatusState(localState, containerIds, excluded);
      return statusValuesFromState(state, new Map());
    });

    const inBitbucketPipeline = isBitbucketPipeline();

    // 3. Missing proceeds to startup; other inspect failures propagate.
    // Verified stopped stacks are recovered unless Bitbucket's lack of named volumes
    // makes removing the Postgres container destructive.
    const inspectDbState = inspectContainerState(spawner, dbContainerId).pipe(
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
    const shouldRecoverStoppedStack = isRecoverableStoppedState(dbState) && !inBitbucketPipeline;

    const reportAlreadyRunningStatus = Effect.fnUntraced(function* () {
      // Gated here on text mode for internal consistency
      // with every other supplementary stderr line this handler prints (see
      // the exclude warning above and the success-path messages below) — this
      // port's `--output-format json|stream-json` callers get a clean
      // structured payload with no extra text noise.
      if (output.format === "text") {
        yield* output.raw(startAlreadyRunningMessage(), "stderr");
      }

      // The full status pipeline for this branch: health-check +
      // "stopped services" diffing, distinct from the success path's direct
      // pretty-print call below (see that branch's own comment for why the
      // two differ).
      if (!flags.ignoreHealthCheck) {
        const state = yield* inspectContainerState(spawner, dbContainerId).pipe(
          Effect.mapError((cause) => new StatusDbInspectError({ message: cause.message })),
        );
        if (!state.running) {
          return yield* Effect.fail(
            new StatusDbNotRunningError({
              message: `${dbContainerId} container is not running: ${state.status}`,
            }),
          );
        }
        if (state.health !== undefined && state.health !== "healthy") {
          return yield* Effect.fail(
            new StatusDbNotReadyError({
              message: `${dbContainerId} container is not ready: ${state.health}`,
            }),
          );
        }
      }

      const runningNames = yield* listContainersByLabel(spawner, {
        projectIdFilter: filterValue,
        all: false,
        format: "names",
      }).pipe(Effect.mapError((cause) => new StatusListError({ message: cause.message })));
      const runningSet = new Set(runningNames);
      const serviceIds = serviceContainerIds(projectId);
      const stopped = serviceIds.filter((id) => !runningSet.has(id));
      // Unconditional here — stderr text, never corrupts a JSON stdout payload.
      if (stopped.length > 0) {
        yield* output.raw(`Stopped services: [${stopped.join(" ")}]\n`, "stderr");
      }
      const excluded = [...stopped, ...flags.exclude];

      if (output.format === "text") {
        // The pretty-branch banner -- distinct from (and printed in
        // ADDITION to) `startAlreadyRunningMessage()` above; both
        // lines really do stack in this branch.
        yield* output.raw(`${aqua("supabase")} local development setup is running.\n\n`, "stderr");
        const { values: statusValues, names } = yield* buildStatusValues(excluded);
        yield* output.raw(renderStatusPretty(statusValues, names));
      } else {
        const { values: statusValues } = yield* buildStatusValues(excluded);
        yield* output.success("", statusValues);
      }
    });

    if (dbState !== undefined && !shouldRecoverStoppedStack) {
      return yield* reportAlreadyRunningStatus();
    }

    // 4. A best-effort update-suggestion check: a Management API call gated
    // on the project being linked AND the user being logged in, purely to
    // print an "update available" hint, every error silently swallowed.
    // Deliberately NOT implemented — this command has zero Management API
    // dependency by design.

    // 5. Gate evaluation — see `start.gates.ts` for the full boolean table.
    // `envOverrideBool` throws synchronously on an unparsable value —
    // wrapped so that throw becomes the typed `StartInvalidConfigError`
    // every other malformed-config path in this handler uses, not an
    // untyped Effect defect.
    const gates = yield* Effect.try({
      try: () =>
        resolveStartGates({
          config,
          projectEnvValues,
          excludedKeys,
          document: context.loaded?.document,
        }),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // 6. JWKS resolution — runs UNCONDITIONALLY, before any image pull,
    // regardless of whether auth/realtime/postgrest/storage end up enabled.
    const jwks = yield* Effect.tryPromise({
      try: () => resolveLocalJwks(config, cliSettings.workdir, values.jwtSecret, projectEnvValues),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // Same treatment as `majorVersion` below, for the sibling
    // `edge_runtime.deno_version` -> image switch, applied before validation
    // at the end of config loading. Start-only (Edge Runtime has no
    // `db start` equivalent), so it stays outside the shared bootstrap-config
    // derivation below.
    const denoVersion = envOverrideDenoVersion(config.edge_runtime.deno_version, projectEnvValues);

    // Every field the fresh-DB bootstrap needs, already resolved — major
    // version, orioledb/S3 overrides, the fresh-DB setup jobs' own
    // `enabled`/`ip_version`/`max_header_length`/`file_size_limit`
    // overrides, the Postgres image + linked-service version pins,
    // `db.health_timeout`, and the Storage migration pin. Shared with
    // `db start`'s own native container bootstrap (`startDatabase`,
    // `command-internal/db-bootstrap/start-database.ts`) — see
    // `bootstrap-config.ts`'s own header for exactly why this is a single
    // TS home instead of two independently-drifting copies.
    const {
      majorVersion,
      orioledbVersion,
      s3Host,
      s3Region,
      s3AccessKey,
      s3SecretKey,
      realtimeEnabledForSetup,
      storageEnabledForSetup,
      authEnabledForSetup,
      realtimeIpVersion,
      realtimeMaxHeaderLength,
      storageFileSizeLimit,
      postgresImage,
      postgresConfigImage,
      serviceVersionOverrides,
      dbHealthTimeoutSeconds,
      storageTargetMigration,
    } = yield* resolveDbBootstrapConfig(
      fs,
      path,
      { config, projectEnvValues, workdir: cliSettings.workdir },
      (message) => new StartInvalidConfigError({ message }),
    );

    // 7. Resolve every image that will actually be pulled BEFORE any
    // container is created.
    const imagePlan = resolveStartImagePlan(gates, serviceVersionOverrides);
    // Edge Runtime doesn't go through `resolveStartImagePlan` (see
    // `start.gates.ts`'s header) — its default image is resolved
    // independently, pre-pulled whenever it's enabled and not excluded.
    const edgeRuntimeDefaultImage = gates.edgeRuntime
      ? yield* resolveEdgeRuntimeImage(fs, path, cliSettings.workdir, denoVersion)
      : undefined;
    // Pre-pull only ever touches non-excluded services, and the
    // one-shot setup-job images are resolved lazily, only when the
    // fresh-DB setup job actually runs (see the conditional resolve further
    // down, gated the same way that job itself is gated).
    const resolvedImages = yield* ensureImagesCached(
      spawner,
      [
        postgresImage,
        ...imagePlan.map((entry) => entry.image),
        ...(edgeRuntimeDefaultImage !== undefined ? [edgeRuntimeDefaultImage] : []),
      ],
      projectEnvValues,
    );
    const resolveImage = (image: string) => resolvedImages.get(image) ?? image;

    // Hoisted out of the Edge Runtime bring-up below: Studio's own bind
    // mounts are resolved UNCONDITIONALLY of `config.edge_runtime.enabled`,
    // so these manifest values must be available to `buildSpecForService`'s
    // "studio" case regardless of whether Edge Runtime itself is enabled.
    //
    // `config.functions.<slug>.env.<VAR>` is schema-marked deferred
    // (`env(...)`, `packages/config/src/lib/env.ts`) and only gets its
    // literal interpolated by `resolveCliConfigSubtree` — without this step, a
    // configured `[functions.<slug>.env]` entry reaches Edge Runtime as the
    // literal string `"env(API_KEY)"` instead of the real secret.
    // `functions serve`'s own call site already resolves this subtree first
    // (`shared/functions/serve.ts:615-622`) before the same
    // `toPlainFunctionRecord` call — same reasoning as `resolvedEdgeRuntime`
    // below, just for the sibling `functions` subtree.
    const resolvedFunctions = yield* resolveCliConfigSubtree(
      config.functions,
      { values: projectEnvValues ?? {} },
      "functions",
      { goViperCompat: true },
    );
    const configDeclaredFunctions = toPlainFunctionRecord(resolvedFunctions);
    const configFunctions = yield* inferFunctionsManifest({
      cwd: cliSettings.workdir,
      config: { ...config, functions: configDeclaredFunctions },
      // `search: false`: `cliSettings.workdir` is already the fully-resolved chdir target (same
      // reasoning as `local-project-context.ts`'s `loadCliProjectEnvironment` call) — letting
      // `findCliProjectPaths` climb ancestors again here would let an unrelated ancestor project's
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
          cliSettings.workdir,
          `${cliSettings.workdir}/supabase`,
          { configDeclaredFunctions, configFunctions, rawConfigFunctions },
          Option.none(),
          Option.none(),
          cliSettings.workdir,
        )
      : new Set<string>();

    // Every container's network mode (and the network it creates) resolves
    // to `--network-id` when set, ahead of the generated
    // `supabase_network_<project>` fallback — and `--network-id` falls back
    // to the `SUPABASE_NETWORK_ID` shell/project-dotenv env var ONLY when
    // the flag was never passed, the same override mechanism as
    // `SUPABASE_YES`/`SUPABASE_EXPERIMENTAL` (review: PRRT_kwDOErm0O86VlqIL).
    // See {@link resolveDockerNetworkMode}'s doc comment for the full 3-way
    // flag/env precedence (shared with `db start` and the `functions`
    // Docker paths).
    const networkIdFlag = yield* NetworkIdFlag;
    const networkId = resolveDockerNetworkMode({
      explicit: Option.getOrUndefined(networkIdFlag),
      envOverride: viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnvValues),
      projectId,
    });
    // Every container unconditionally gets the Linux-only
    // `host.docker.internal:host-gateway` extra host (empty on
    // darwin/windows, where Docker Desktop already resolves that hostname)
    // — same expression already used for the one-shot migrate jobs
    // (`db-setup.ts`) and Edge Runtime bring-up
    // (`edge-runtime-script.layer.ts`).
    const extraHosts =
      runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
    const startOpts: ContainerOpts = {
      projectId,
      isBitbucketPipeline: inBitbucketPipeline,
      workdir: cliSettings.workdir,
      extraHosts,
    };
    const dbHost = dbContainerId;
    const dbPassword = startInternalDbPassword(values.dbUrl);

    const kongContainerName = serviceContainerName("kong", projectId);
    const gotrueContainerName = serviceContainerName("auth", projectId);
    const restContainerName = serviceContainerName("rest", projectId);
    const realtimeContainerName = serviceContainerName("realtime", projectId);
    const storageContainerName = serviceContainerName("storage", projectId);
    const studioContainerName = serviceContainerName("studio", projectId);
    const pgMetaContainerName = serviceContainerName("pg_meta", projectId);
    const edgeRuntimeContainerName = serviceContainerName("edge_runtime", projectId);
    const logflareContainerName = serviceContainerName("analytics", projectId);
    const poolerContainerName = serviceContainerName("pooler", projectId);
    const vectorContainerName = serviceContainerName("vector", projectId);
    const mailpitContainerName = serviceContainerName("inbucket", projectId);

    // The TLS cert/key disk read is gated on the post-override
    // `api.enabled` itself, not just `api.tls.enabled`: when API is
    // disabled, `CertContent`/`KeyContent` stay at their embedded defaults.
    // Not the SAME `apiEnabled` `resolveStartGates` (`start.gates.ts:87-92`)
    // computes for its own `gates.postgrest` — that one is additionally
    // ANDed with `--exclude postgrest`, which has no equivalent in config
    // validation — so this is resolved separately here.
    const apiEnabled = yield* wrapConfigOverride("api.enabled", () =>
      envOverrideBool("SUPABASE_API_ENABLED", config.api.enabled, "api.enabled", projectEnvValues),
    );
    // Hoisted out of the "kong" case below (it used to be computed only
    // there): the post-bring-up health-probe CA-trust lookup near the end of
    // this function needs the SAME env-overridden value, not the raw
    // `config.api.tls.enabled` — there must be one source of truth here,
    // since the health probe's trust pool and its target URL both read
    // that same already-overridden value.
    const apiTlsEnabled = yield* wrapConfigOverride("api.tls.enabled", () =>
      envOverrideBool(
        "SUPABASE_API_TLS_ENABLED",
        config.api.tls.enabled,
        "api.tls.enabled",
        projectEnvValues,
      ),
    );
    // Same override gap as `apiTlsEnabled` above, for the two custom
    // cert/key path fields — `SUPABASE_API_TLS_CERT_PATH`/
    // `SUPABASE_API_TLS_KEY_PATH` must apply before reading `CertPath`/
    // `KeyPath` from disk into `CertContent`/`KeyContent`. Mirrors the
    // identical resolution `local-config-values.ts` already does for
    // `status`/`stop`.
    const apiTlsCertPath = envOverride(
      "SUPABASE_API_TLS_CERT_PATH",
      config.api.tls.cert_path,
      projectEnvValues,
    );
    const apiTlsKeyPath = envOverride(
      "SUPABASE_API_TLS_KEY_PATH",
      config.api.tls.key_path,
      projectEnvValues,
    );
    // These seed from the embedded defaults, then get replaced from disk
    // (below) before any Docker mutation.
    let tlsCertContent = KONG_LOCAL_TLS_CERT;
    let tlsKeyContent = KONG_LOCAL_TLS_KEY;
    if (
      apiEnabled &&
      apiTlsEnabled &&
      apiTlsCertPath !== undefined &&
      apiTlsCertPath.length > 0 &&
      apiTlsKeyPath !== undefined &&
      apiTlsKeyPath.length > 0
    ) {
      tlsCertContent = yield* fs
        .readFileString(resolveApiTlsPath(cliSettings.workdir, apiTlsCertPath))
        .pipe(
          Effect.mapError(
            (cause) =>
              new StartInvalidConfigError({
                message: apiTlsCertReadErrorMessage(cause),
              }),
          ),
        );
      tlsKeyContent = yield* fs
        .readFileString(resolveApiTlsPath(cliSettings.workdir, apiTlsKeyPath))
        .pipe(
          Effect.mapError(
            (cause) =>
              new StartInvalidConfigError({
                message: apiTlsKeyReadErrorMessage(cause),
              }),
          ),
        );
    }

    // Same gap for `storage.vector.enabled` — both the long-running Storage
    // container AND `seedBucketsRun`'s `effectiveLocalStorageConfig`
    // splice further down must see the same already-overridden value.
    const storageVectorEnabled = yield* wrapConfigOverride("storage.vector.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_VECTOR_ENABLED",
        config.storage.vector.enabled,
        "storage.vector.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `storage.s3_protocol.enabled` — a plain bool that must
    // validate unconditionally before any Docker work, the exact same
    // mechanism as `storage.vector.enabled` above. The Storage spec builder
    // below only parsed this lazily, so it was silently accepted when
    // Storage is excluded/disabled — same class of gap already fixed for
    // `storage.file_size_limit`, the GoTrue duration fields, and
    // `db.health_timeout`.
    const storageS3ProtocolEnabled = yield* wrapConfigOverride("storage.s3_protocol.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        config.storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `storage.analytics.enabled` — the `Enabled` bool sibling
    // of the `max_namespaces`/`max_tables`/`max_catalogs` uint fields
    // validated below, all of which must validate unconditionally, before
    // any Docker work. `start` itself never reads this field locally (only
    // `seed buckets --linked` does, unreachable from `start`'s own inline
    // seeding since every call here passes `projectRef: ""`) — validate
    // purely for fail-fast parity and discard the result, same as the uint
    // siblings below.
    yield* wrapConfigOverride("storage.analytics.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_ANALYTICS_ENABLED",
        config.storage.analytics.enabled,
        "storage.analytics.enabled",
        projectEnvValues,
      ),
    );
    // `storage.analytics.{max_namespaces,max_tables,max_catalogs}` and
    // `storage.vector.{max_buckets,max_indexes}` are plain `uint`s that must
    // validate unconditionally, before any Docker work, the same as every
    // other field above. Unlike their `enabled` siblings above, `start`'s
    // own logic never reads these fields (only `config push`/`pull` do), so
    // there is no downstream re-resolution to reuse — validate purely for
    // fail-fast parity and discard the result.
    yield* wrapConfigOverride("storage.analytics.max_namespaces", () =>
      envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
        "storage.analytics.max_namespaces",
        config.storage.analytics.max_namespaces,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.analytics.max_tables", () =>
      envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
        "storage.analytics.max_tables",
        config.storage.analytics.max_tables,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.analytics.max_catalogs", () =>
      envOverrideUint(
        "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
        "storage.analytics.max_catalogs",
        config.storage.analytics.max_catalogs,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.vector.max_buckets", () =>
      envOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
        "storage.vector.max_buckets",
        config.storage.vector.max_buckets,
        projectEnvValues,
      ),
    );
    yield* wrapConfigOverride("storage.vector.max_indexes", () =>
      envOverrideUint(
        "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
        "storage.vector.max_indexes",
        config.storage.vector.max_indexes,
        projectEnvValues,
      ),
    );

    // Same gap for `api.schemas`/`api.extra_search_path`/`api.max_rows` —
    // both PostgREST's own container AND Studio's copy of the same
    // PGRST_DB_* env must see the same already-overridden values. The two
    // array fields use the same comma-split-override pattern as
    // `auth.additional_redirect_urls`/`auth.webauthn.rp_origins` above.
    const apiSchemasOverride = envOverride("SUPABASE_API_SCHEMAS", undefined, projectEnvValues);
    const apiSchemas =
      apiSchemasOverride !== undefined ? apiSchemasOverride.split(",") : config.api.schemas;
    const apiExtraSearchPathOverride = envOverride(
      "SUPABASE_API_EXTRA_SEARCH_PATH",
      undefined,
      projectEnvValues,
    );
    const apiExtraSearchPath =
      apiExtraSearchPathOverride !== undefined
        ? apiExtraSearchPathOverride.split(",")
        : config.api.extra_search_path;
    const apiMaxRows = yield* wrapConfigOverride("api.max_rows", () =>
      envOverrideApiMaxRows(config.api.max_rows, projectEnvValues),
    );

    // Same gap for Mailpit's three ports — `SUPABASE_LOCAL_SMTP_PORT`/
    // `_SMTP_PORT`/`_POP3_PORT` must apply before building Mailpit's port
    // bindings. `smtp_port`/`pop3_port` have no TOML default, matching
    // `mailpit.service.ts`'s own `!== 0` publish guard, so `?? 0` here
    // preserves that "unconfigured" signal.
    const mailpitPort = yield* wrapConfigOverride("local_smtp.port", () =>
      envOverridePort(
        "SUPABASE_LOCAL_SMTP_PORT",
        config.local_smtp.port,
        "local_smtp.port",
        projectEnvValues,
      ),
    );
    const mailpitSmtpPort = yield* wrapConfigOverride("local_smtp.smtp_port", () =>
      envOverridePort(
        "SUPABASE_LOCAL_SMTP_SMTP_PORT",
        config.local_smtp.smtp_port ?? 0,
        "local_smtp.smtp_port",
        projectEnvValues,
      ),
    );
    const mailpitPop3Port = yield* wrapConfigOverride("local_smtp.pop3_port", () =>
      envOverridePort(
        "SUPABASE_LOCAL_SMTP_POP3_PORT",
        config.local_smtp.pop3_port ?? 0,
        "local_smtp.pop3_port",
        projectEnvValues,
      ),
    );

    // Same gap for Logflare's port — `SUPABASE_ANALYTICS_PORT` must apply
    // before building Logflare's host port binding.
    const analyticsPort = yield* wrapConfigOverride("analytics.port", () =>
      envOverridePort(
        "SUPABASE_ANALYTICS_PORT",
        config.analytics.port,
        "analytics.port",
        projectEnvValues,
      ),
    );
    // Same gap for Logflare's deprecated Vector port —
    // `analytics.vector_port` (a `uint16`, "Deprecated together with
    // syslog") must validate unconditionally too; nothing downstream in
    // `start` reads the resolved value, but a malformed override must still
    // fail before any Docker work. Result discarded — no native code path
    // consumes it.
    yield* wrapConfigOverride("analytics.vector_port", () =>
      envOverridePort(
        "SUPABASE_ANALYTICS_VECTOR_PORT",
        config.analytics.vector_port ?? 0,
        "analytics.vector_port",
        projectEnvValues,
      ),
    );

    // Same gap for Supavisor's pooler fields — `SUPABASE_DB_POOLER_*` must
    // apply before building the pooler's port/mode fields; `pool_mode`
    // specifically decides the published host port (5432 session vs 6543
    // transaction). All four throw synchronously on a malformed override —
    // wrapped via `wrapConfigOverride` so a bad value fails as a typed
    // `StartInvalidConfigError` instead of an untyped Effect defect
    // bypassing `withJsonErrorHandling`'s `Effect.catch`
    // (see `wrapConfigOverride`'s doc comment) — same bug class already fixed
    // for `dbHealthTimeoutSeconds`/`db.settings`/the Edge Runtime
    // `policy`/`inspector_port` overrides elsewhere in this function.
    const poolerPort = yield* wrapConfigOverride("db.pooler.port", () =>
      envOverridePort(
        "SUPABASE_DB_POOLER_PORT",
        config.db.pooler.port,
        "db.pooler.port",
        projectEnvValues,
      ),
    );
    const poolMode = yield* wrapConfigOverride("db.pooler.pool_mode", () =>
      envOverridePoolMode(config.db.pooler.pool_mode, projectEnvValues),
    );
    const poolerDefaultPoolSize = yield* wrapConfigOverride("db.pooler.default_pool_size", () =>
      envOverrideDefaultPoolSize(config.db.pooler.default_pool_size, projectEnvValues),
    );
    const poolerMaxClientConn = yield* wrapConfigOverride("db.pooler.max_client_conn", () =>
      envOverrideMaxClientConn(config.db.pooler.max_client_conn, projectEnvValues),
    );

    // Same bug class as `dbHealthTimeoutSeconds` (now resolved by the shared
    // `resolveDbBootstrapConfig` call above): `edge_runtime.policy`
    // (an enum) and `edge_runtime.inspector_port` (a plain uint) decode during
    // the same unconditional config-load pass, before
    // any Docker work — regardless of `--exclude edge-runtime`. The Edge Runtime
    // branch below re-resolves both against `resolvedEdgeRuntime`'s env-interpolated subtree
    // for the real container build; this eager call only needs the raw `config.edge_runtime`
    // value to prove it parses.
    const edgeRuntimePolicy = yield* wrapConfigOverride("edge_runtime.policy", () =>
      envOverrideEdgeRuntimePolicy(config.edge_runtime.policy, projectEnvValues),
    );
    const edgeRuntimeInspectorPort = yield* wrapConfigOverride("edge_runtime.inspector_port", () =>
      envOverridePort(
        "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
        config.edge_runtime.inspector_port,
        "edge_runtime.inspector_port",
        projectEnvValues,
      ),
    );

    /**
     * Every case returns `{ spec, excludeFromHealthWatch? }`: `spec` is the
     * {@link StartContainerSpec} to bring up; `excludeFromHealthWatch`
     * (only ever set by "vector") is returned explicitly instead of a
     * captured mutable variable — Vector's `npipe`-scheme exception is the
     * only case that ever sets it.
     */
    const buildSpecForService = Effect.fnUntraced(function* (service: string, image: string) {
      switch (service) {
        case "logflare":
          return {
            spec: buildLogflareContainerSpec({
              image,
              projectId,
              networkId,
              port: analyticsPort,
              backend: values.analyticsBackend,
              gcpProjectId: values.gcpProjectId,
              gcpProjectNumber: values.gcpProjectNumber,
              gcpJwtPath: values.gcpJwtPath,
              workdir: cliSettings.workdir,
              dbHost,
              dbPort: START_INTERNAL_DB_PORT,
              dbUser: "postgres",
              dbPassword,
            }),
          };

        case "vector": {
          const daemonHost = yield* resolveDockerDaemonHost(spawner);
          const dockerSocketPlan = resolveVectorDockerSocketPlan(daemonHost);
          // A Windows-only warning — gated on text mode for the same reason
          // as every other supplementary line here.
          if (dockerSocketPlan.isNpipe && output.format === "text") {
            yield* output.raw(
              `${yellow("WARNING:")} Analytics on Windows requires Docker daemon exposed on tcp://localhost:2375.\n` +
                "See https://supabase.com/docs/guides/local-development/cli/getting-started?queryGroups=platform&platform=windows#running-supabase-locally for more details.\n",
              "stderr",
            );
          }
          return {
            spec: buildVectorContainerSpec({
              image,
              containerName: vectorContainerName,
              networkId,
              apiKey: ANALYTICS_API_KEY,
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
            // Vector's `npipe`-scheme exception: still created/started, just
            // never added to the health-wait watch list.
            excludeFromHealthWatch: dockerSocketPlan.isNpipe,
          };
        }

        case "kong": {
          return {
            spec: buildKongContainerSpec({
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
              realtimeTenantId: REALTIME_TENANT_ID,
              storageId: storageContainerName,
              studioId: studioContainerName,
              pgmetaId: pgMetaContainerName,
              edgeRuntimeId: edgeRuntimeContainerName,
              logflareId: logflareContainerName,
              poolerId: poolerContainerName,
              nginxWorkerProcesses: resolveKongNginxWorkerProcesses(projectEnvValues),
              emailTemplateMounts: kongEmailTemplateMounts,
            }),
          };
        }

        case "gotrue":
          return {
            spec: buildGotrueContainerSpec({
              image,
              projectId,
              networkId,
              dbUrl: values.dbUrl,
              env: resolveGotrueEnvInput({
                context,
                values,
                workdir: cliSettings.workdir,
                kongContainerName,
                mailpitContainerName,
                resolvedEmail,
              }),
            }),
          };

        case "mailpit":
          return {
            spec: buildMailpitContainerSpec({
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
            spec: buildRealtimeContainerSpec({
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
            spec: buildPostgrestContainerSpec({
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
            spec: buildStorageContainerSpec({
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
          return { spec: buildImgproxyContainerSpec({ projectId, networkId, image }) };

        case "pgMeta":
          return {
            spec: buildPgMetaContainerSpec({
              image,
              containerName: pgMetaContainerName,
              dbHost,
              dbPort: START_INTERNAL_DB_PORT,
              dbUser: "postgres",
              dbPassword,
              dbName: START_INTERNAL_DB_NAME,
              networkId,
            }),
          };

        case "studio": {
          return {
            spec: buildStudioContainerSpec({
              image,
              containerName: studioContainerName,
              networkId,
              port: values.studioPort,
              // Computed whenever Studio is enabled, independently of Edge Runtime.
              // Resolved during preflight above so recovery teardown remains reversible.
              functionBinds: [...studioFunctionBinds],
              env: {
                dbPassword,
                workdir: cliSettings.workdir,
                cliVersion: CLI_VERSION,
                pgMetaContainerName,
                kongContainerName,
                logflareContainerName,
                studioApiUrl: resolveStudioApiUrl(
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
            spec: buildSupavisorContainerSpec({
              image,
              projectId,
              networkId,
              port: poolerPort,
              poolMode,
              defaultPoolSize: poolerDefaultPoolSize,
              maxClientConn: poolerMaxClientConn,
              jwtSecret: values.jwtSecret,
              dbHost,
              dbPort: START_INTERNAL_DB_PORT,
              dbUser: "postgres",
              dbPassword,
              dbDatabase: START_INTERNAL_DB_NAME,
            }),
          };

        default:
          return yield* Effect.die(`start: unrecognized service "${service}"`);
      }
    });

    // `isFreshVolume`: set once, inside the pre-create volume-existence
    // check, then read much later on a rollback. A plain outer `let` is
    // this port's equivalent of a mutable global shared across that whole
    // window — unlike `excludeFromHealthWatch` (returned explicitly from
    // `buildSpecForService` because a clean return-value alternative
    // existed there), `isFreshVolume` must survive PAST `bringUp`'s own
    // failure path (`Effect.onError` below, which runs on ANY failure —
    // including a defect or interrupt — and has no access to a value
    // `bringUp` only returns on success) — there is no non-mutable way to
    // thread a value computed mid-effect into a sibling failure handler.
    let isFreshVolume = false;

    // 8. Bring-up: network -> Postgres (+ its own health wait, GATED on
    // `--ignore-health-check` exactly like every other service's wait below
    // — this must propagate a Postgres health-wait failure immediately,
    // before "Starting containers..." even prints — there is no
    // Postgres-specific carve-out) -> the fresh-volume-gated
    // `SetupLocalDatabase` equivalent (BEFORE any other service starts) ->
    // the 12 remaining enabled+non-excluded services plus Edge Runtime, in
    // the real start order (`start.gates.ts`'s `imagePlan` + `edgeRuntime`).
    // Any OTHER failure in this whole phase (including a NON-ignored
    // Postgres timeout) rolls back and fails the command outright. An
    // IGNORED Postgres timeout instead short-circuits to `{ kind:
    // "postgresUnhealthyIgnored" }` below — skipping every later step in
    // this phase, and the bulk health check/bucket seeding/
    // `cli_stack_started` capture after it — while still letting the
    // command reach the final "Started..." tail, printing the warning and
    // falling through to that SAME unconditional tail rather than returning
    // early from the whole command.
    const bringUp = Effect.gen(function* () {
      // `--debug` — threaded into `setup.debug` below so a failed fresh-volume
      // Realtime/Storage/Auth migrate job (see `db-setup.ts`'s `runStartMigrateJob`
      // doc comment) tees its own stderr.
      const bringUpDebug = yield* DebugFlag;

      // Runs the DB bootstrap sequence (network -> volume probe -> container
      // create+start -> health wait -> fresh-volume setup -> `_current_branch`) — shared
      // with `db start`'s own native container bootstrap, see `startDatabase`'s own
      // header (`command-internal/db-bootstrap/start-database.ts`) for the full call order and
      // for why this function has zero knowledge of `--ignore-health-check`: that decision
      // belongs entirely to THIS caller, immediately below.
      const dbBootstrapResult = yield* startDatabase(spawner, {
        fs,
        path,
        workdir: cliSettings.workdir,
        projectId,
        networkId,
        hostname: context.hostname,
        dbContainerId,
        dbPort: values.dbPort,
        containerOpts: startOpts,
        postgresSpec: {
          // `port` overridden by SUPABASE_DB_PORT — the published port binds
          // straight from the already-overridden `config.db.port`.
          // `settings` overridden by any `SUPABASE_DB_SETTINGS_*` field —
          // serialized from the same already-overridden `config.db.settings`.
          db: {
            ...config.db,
            port: values.dbPort,
            major_version: majorVersion,
            settings: resolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues),
          },
          // `orioledb_version` overridden by SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION,
          // matching the value already used to select `postgresImage` above —
          // `postgresExtraEnv` reads this same field, and its four sibling
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
          // Overridden by SUPABASE_AUTH_JWT_EXPIRY — Postgres's JWT_EXP
          // (seeding app.settings.jwt_exp) and GoTrue's GOTRUE_JWT_EXP both
          // read the same already-overridden value; using the raw config
          // value here would let Postgres and GoTrue disagree.
          jwtExpiry: values.authJwtExpiry,
          projectId,
          networkId,
          configImage: postgresConfigImage,
          rootKey: values.rootKey,
          // `fromBackup` stays unset: `supabase start` always calls the DB
          // bootstrap with an empty `fromBackup` — only `db start` ever sets it.
        },
        // Already resolved as part of THIS run's own batched pre-pull (`resolvedImages`,
        // above) — `supabase start` has no per-container lazy resolve of its own, unlike
        // `db start` (see `startDatabase`'s header for why this is caller-supplied).
        resolvePostgresImage: Effect.succeed(resolveImage(postgresImage)),
        dbHealthTimeoutSeconds,
        webhooksEnabled: dbTomlValues.webhooksEnabled,
        setup: {
          majorVersion,
          experimental,
          // The fresh-volume setup's per-job gates read the EFFECTIVE,
          // env-overridden `{Realtime,Storage,Auth}.enabled` values, NOT
          // additionally filtered by `--exclude` the way `gates.*` is — the
          // one-shot migration jobs run regardless of `--exclude`, since
          // they're part of the DB bootstrap, which finishes before this
          // handler's own excluded-services filtering even begins.
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
          dbUrl: values.dbUrl,
          jwtSecret: values.jwtSecret,
          // Already resolved, unconditionally, near the top of THIS handler's own prelude
          // (feeding the long-running Realtime/GoTrue/PostgREST containers too) — reused
          // here rather than re-resolved, see `startDatabase`'s header for why.
          jwks: Effect.succeed(jwks),
          apiUrl: values.apiUrl,
          authExternalUrl: resolveAuthExternalUrl(context.loaded?.document, projectEnvValues),
          siteUrl: values.authSiteUrl,
          anonKey: values.anonKey,
          serviceRoleKey: values.serviceRoleKey,
          storageTargetMigration,
          realtimeEnabledForSetup,
          storageEnabledForSetup,
          authEnabledForSetup,
          serviceVersionOverrides,
          projectEnvValues,
          debug: bringUpDebug,
        },
        onFreshVolumeResolved: (resolved) => {
          isFreshVolume = resolved;
        },
      }).pipe(Effect.result);

      if (Result.isFailure(dbBootstrapResult)) {
        const error = dbBootstrapResult.failure;
        if (flags.ignoreHealthCheck && isUnhealthyStartError(error)) {
          // `ignoreHealthCheck && isUnhealthyStartError(error)` applies
          // uniformly to whatever the DB bootstrap returns AS A WHOLE —
          // including Postgres's own health-wait error, which propagates
          // immediately, before any of the steps below (fresh-volume setup,
          // `initCurrentBranch`, every other service, the bulk health check)
          // ever run. Downgrade to a warning and short-circuit the rest of
          // this phase, falling through to the SAME unconditional tail
          // every other path reaches, not an early return from the whole
          // command.
          yield* output.raw(`${healthWarningText(error)}\n`, "stderr");
          return { kind: "postgresUnhealthyIgnored" as const };
        }
        return yield* Effect.fail(error);
      }

      if (output.format === "text") {
        yield* output.raw(START_STARTING_CONTAINERS_MESSAGE, "stderr");
      }

      // An insertion-ordered container NAME -> resolved image map. Watches
      // container names, not the ids `docker create` returns, so an
      // unhealthy container reports as `supabase_auth_demo` rather than 64
      // hex characters. Keying the images by that same name keeps the watch
      // list and its images from drifting apart.
      const started = new Map<string, string>();
      let postgrestGateway: HealthCheckPostgrestGateway | undefined;
      let edgeRuntimeGateway: HealthCheckPostgrestGateway | undefined;
      let storageContainerId: string | undefined;
      const imagePlanByService = new Map(imagePlan.map((entry) => [entry.service, entry.image]));
      for (const entry of START_SERVICES) {
        if (entry.service === "postgres") continue;

        // Edge Runtime doesn't go through `imagePlan`/`buildSpecForService` —
        // see `start.gates.ts`'s header — so it's special-cased here, in its
        // real relative position (between ImgProxy and pg-meta).
        if (entry.service === "edgeRuntime") {
          if (!gates.edgeRuntime || edgeRuntimeDefaultImage === undefined) continue;
          // `config.edge_runtime.secrets` is still schema-decoded plain
          // strings here — `toPlainEdgeRuntimeConfig` only emits entries
          // whose values are `Redacted` (`shared/functions/serve.ts`), and a
          // value only becomes `Redacted` after `resolveCliConfigSubtree`'s
          // env-interpolation + secret-path-redaction pass. Without this step
          // every configured `[edge_runtime.secrets]` entry is silently
          // dropped — `functions serve`'s own call site already resolves the
          // subtree first (`shared/functions/serve.ts:603-610`) before
          // calling the same helper.
          const resolvedEdgeRuntime = yield* resolveCliConfigSubtree(
            config.edge_runtime,
            { values: projectEnvValues ?? {} },
            "edge_runtime",
            { goViperCompat: true },
          );
          // Every `config.Secret`-typed field (including
          // `edge_runtime.secrets`) must be decrypted unconditionally, so
          // the real Edge Runtime container always receives plaintext.
          // `toPlainEdgeRuntimeConfig` only does `env()` interpolation and
          // `Redacted`-unwrapping — it never decrypts a dotenvx `encrypted:`
          // value — so without this step the literal ciphertext would reach
          // the container's env file. `checkDbToml` (called
          // unconditionally, before any Docker work) already validates
          // every `edge_runtime.secrets.*` entry is decryptable via
          // `assertDecryptableSecrets`, but only for that validation's
          // own side effect — the decrypted plaintext is discarded there,
          // not threaded back into this value.
          const rawEdgeRuntimeSecrets = toPlainEdgeRuntimeConfig(resolvedEdgeRuntime).secrets;
          const dotenvPrivateKeys = collectDotenvPrivateKeys({
            ...projectEnvValues,
            ...process.env,
          });
          const edgeRuntimeSecrets: Record<string, string> = {};
          for (const [secretName, secretValue] of Object.entries(rawEdgeRuntimeSecrets)) {
            if (!isEncryptedSecret(secretValue)) {
              edgeRuntimeSecrets[secretName] = secretValue;
              continue;
            }
            const decrypted = decryptSecret(secretValue, dotenvPrivateKeys);
            if (!decrypted.ok) {
              return yield* Effect.fail(
                new StartInvalidConfigError({
                  message: `failed to parse config: ${decrypted.error}`,
                }),
              );
            }
            edgeRuntimeSecrets[secretName] = decrypted.value;
          }
          // `edgeRuntimePolicy`/`edgeRuntimeInspectorPort` are resolved eagerly, before any
          // Docker work — see their hoisted `wrapConfigOverride` calls next to
          // `dbHealthTimeoutSeconds` above.
          const edgeRuntimeInput: EdgeRuntimeBringUpInput = {
            projectId,
            networkId,
            image: resolveImage(edgeRuntimeDefaultImage),
            workdir: cliSettings.workdir,
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
          const runtime: StartedRuntime = yield* startStackEdgeRuntimeContainer(edgeRuntimeInput);
          // Deliberately NOT calling `runtime.cleanup` here — see
          // `edge-runtime.service.ts`'s header for why. Unlike every other
          // service built here (`createContainer`'s `restartPolicy:
          // "unless-stopped"`), Edge Runtime's own bring-up sets no Docker
          // restart policy at all — but its bind-mounted host temp files
          // (env-file/multiline-env-script staging) must still exist for
          // as long as the container can be reattached to; `start
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

        // Several service builders do synchronous, throwing work over
        // config.toml string fields `@supabase/config`'s schema does not
        // itself validate as durations/sizes (GoTrue's
        // `auth.email/sms.max_frequency`/sessions/mfa duration parsing and
        // Storage's file-size-limit parsing are now caught earlier, eagerly,
        // before any Docker work — see the `resolvedEmail`/
        // `storageFileSizeLimit` validation above — but this `catchDefect`
        // stays as defense-in-depth for any other field of this shape). A
        // malformed value would otherwise surface as an uncaught Effect
        // defect — `Effect.onError` below still rolls back on a defect
        // either way, but the user would see an opaque defect instead of a
        // typed config error. `catchDefect` converts any such throw into
        // the same typed config error every other malformed-config path in
        // this handler already produces, matching the fail-fast-at-decode
        // behavior every other field validates with.
        const resolvedServiceImage = resolveImage(image);
        const { spec, excludeFromHealthWatch } = yield* buildSpecForService(
          entry.service,
          resolvedServiceImage,
        ).pipe(
          Effect.catchDefect((defect) =>
            Effect.fail(
              new StartInvalidConfigError({
                message: `invalid config for ${entry.service}: ${defect instanceof Error ? defect.message : String(defect)}`,
              }),
            ),
          ),
        );
        yield* createContainer(spawner, spec, startOpts);
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
      // The rollback's `NoBackupVolume` value — `true` only when this run's
      // Postgres volume was freshly created (see `isFreshVolume` above): a
      // rollback prunes volumes on a brand-new, empty first-ever `start`,
      // but never touches a pre-existing user's data on a failed restart.
      //
      // `Effect.onError`, not `Effect.tapError`: this must roll back on ANY
      // failure from bring-up, including a `context.Canceled`-equivalent
      // interrupt from a SIGINT during bring-up. `tapError` is built on
      // `Cause.findError`, which only matches `Fail` reasons — a pure fiber
      // interrupt never reaches it. `onError` fires on any failure outcome
      // (including interruption) and its cleanup effect runs
      // uninterruptibly, matching the unconditional rollback check every
      // other failure path in this handler needs.
      Effect.onError(() =>
        rollbackStart(spawner, filterValue, isFreshVolume, cliSettings.workdir, debug),
      ),
    );

    if (shouldRecoverStoppedStack) {
      // Recheck after preflight in case Docker or another process restarted the stack.
      const recheckedState = yield* inspectDbState;
      if (recheckedState !== undefined && !isRecoverableStoppedState(recheckedState)) {
        return yield* reportAlreadyRunningStatus();
      }
      // cliProjectFilterValue("") targets every CLI-managed project; never use it here.
      if (projectId.length === 0) {
        return yield* Effect.fail(
          new StartInvalidConfigError({
            message: "Invalid config: project_id must contain at least one alphanumeric character.",
          }),
        );
      }
      let removedContainers: ReadonlyArray<ContainerIdName> = [];
      yield* dockerRemoveAll(
        spawner,
        filterValue,
        false,
        (containers) => {
          // Recovery only trusts its own workdir; empty labels use the existing fallback.
          removedContainers = containers.filter(
            (container) =>
              container.workdir.length === 0 || container.workdir === cliSettings.workdir,
          );
        },
        debug,
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() => cleanupStartSecrets(removedContainers, cliSettings.workdir)),
        ),
      );
    }

    const bringUpResult = yield* bringUp;

    // Only reached when Postgres itself became healthy (or the volume
    // already existed) — the `postgresUnhealthyIgnored` short-circuit above
    // skips this entire block, falling through to the tail below either way
    // but never re-entering these later steps once the DB bootstrap has
    // already returned.
    if (bringUpResult.kind === "started") {
      const { started, postgrestGateway, edgeRuntimeGateway, storageContainerId } = bringUpResult;

      // Wraps steps 9-11 below (bulk health wait, the ignore-health-check
      // storage-only recheck-and-seed, the success-path bucket seeding, and
      // the `cli_stack_started` capture) in the same `Effect.onError` rollback
      // `bringUp`'s own pipe uses above. This whole tail must be checked for
      // a single failure outcome exactly once — a SIGINT/SIGTERM landing
      // anywhere in this tail, not just during bring-up, must roll back
      // too. Per-step manual `rollbackStart` calls would miss a pure
      // fiber interrupt between steps (see the `bringUp` pipe's doc comment
      // for why `onError`, not `tapError`, is required), so every fail path
      // below just fails and lets this single outer `onError` roll back.
      yield* Effect.gen(function* () {
        // 9. Bulk health check over every non-Postgres started container, at
        // the generic 30s service timeout.
        if (output.format === "text") {
          yield* output.raw(START_WAITING_FOR_HEALTH_CHECKS_MESSAGE, "stderr");
        }
        // The PostgREST/Edge Runtime readiness probes go through Kong over HTTP(S) —
        // when `api.tls.enabled`, Kong's local cert is self-signed, so the root
        // runtime's `HttpClient.HttpClient` (built from `FetchHttpClient.layer` over
        // plain `fetch`) would fail TLS verification on every probe and the health
        // check would exhaust its full timeout even though the services are
        // actually healthy. Resolve the same local Kong CA `seedBucketsRun`'s
        // own gateway calls already trust (`projectRef: ""` never touches the
        // network — see `resolveStorageCredentials`'s local branch) and
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
        // external URL also reaches every local Storage-gateway caller below.
        // `resolveStorageCredentials` now folds the same `SUPABASE_API_*`
        // overrides itself (`resolveLocalApiConfig`,
        // `storage-credentials.ts` — #6452) and re-resolves this
        // pre-folded config to identical values, so the api fold here is what
        // guarantees the exact resolved-URL/TLS/cert locals Kong's own spec used
        // (`apiEnabled`/`apiTlsCertPath`/`apiTlsKeyPath`) are the ones handed
        // on. Also folds in the
        // already-resolved `values.jwtSecret`/`values.serviceRoleKey` (decrypted,
        // env/dotenv-overridden, signing-keys-aware — the same values the real
        // GoTrue/Storage containers were started with) instead of the raw
        // `config.auth.*`. `resolveStorageCredentials`'s local branch now
        // applies the same env/dotenv override + decrypt composition itself,
        // but its own derivation is symmetric-only (`generateGoJwt`), so this
        // fold remains load-bearing for the `signing_keys_path` case where
        // `values.serviceRoleKey` is asymmetric-signed.
        // Also folds in `storageFileSizeLimit`/
        // `storageVectorEnabled` so `seedBucketsRun` (which reads
        // `config.storage.file_size_limit`/`config.storage.vector.enabled` to fill
        // bucket defaults and gate vector-upsert seeding, `seed-buckets.ts`)
        // sees the same values the real Storage container was started with, not the
        // raw un-overridden config.
        // Reused for both this health-check CA lookup and the two
        // `seedBucketsRun` calls below (`resolvedConfig`), so bucket
        // seeding never independently reloads config.toml and silently drops
        // these same overrides.
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
        const { localKongCa } = yield* resolveStorageCredentials({
          projectRef: "",
          config: effectiveLocalStorageConfig,
          projectEnvValues,
        });
        // Shared by every gateway probe below (the bulk wait and the
        // storage-only recheck), so both trust the same local Kong CA.
        const withLocalKongCa = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          localKongCa === undefined
            ? effect
            : effect.pipe(
                Effect.provideService(FetchHttpClient.Fetch, storageGatewayFetch(localKongCa)),
              );
        // Keep the synthetic value out of project dotenv resolution and container environments.
        configureLoopbackProxyBypass();
        const healthResult = yield* withLocalKongCa(
          waitForHealthyServices(spawner, [...started.keys()], {
            postgrest: postgrestGateway,
            edgeRuntime: edgeRuntimeGateway,
            images: started,
          }),
        ).pipe(Effect.result);
        if (Result.isFailure(healthResult)) {
          const error = healthResult.failure;
          if (flags.ignoreHealthCheck && isUnhealthyStartError(error)) {
            // `ignoreHealthCheck`/`isUnhealthyStartError` only gates THIS
            // wait, not Postgres's own earlier one. There's additionally a
            // narrower, storage-only recheck-and-seed here: when it's a fresh
            // volume and Storage was among the
            // started containers, wait for Storage alone to become healthy, and
            // if it does, seed buckets. A seed FAILURE there REPLACES this
            // original health error and hard-fails (with rollback) —
            // since a plain seed error never satisfies
            // `isUnhealthyStartError` and so never gets this branch's own
            // downgrade-to-warning treatment. A seed SUCCESS (or a storage
            // recheck that never turns healthy) changes nothing: fall through to
            // the same downgrade-to-warning as every other ignored-unhealthy
            // failure.
            if (isFreshVolume && storageContainerId !== undefined) {
              // `images` is intentionally the whole run's registry, not scoped to
              // this one-container watch list — the hint can only ever key off
              // containers that actually appear in this call's own failures.
              const storageHealthResult = yield* withLocalKongCa(
                waitForHealthyServices(spawner, [storageContainerId], {
                  images: started,
                }),
              ).pipe(Effect.result);
              if (Result.isSuccess(storageHealthResult)) {
                const seedResult = yield* seedBucketsRun({
                  projectRef: "",
                  emitSummary: false,
                  interactive: false,
                  yes: true,
                  resolvedConfig: {
                    config: effectiveLocalStorageConfig,
                    document: context.loaded?.document,
                  },
                  projectEnvValues,
                }).pipe(Effect.result);
                if (Result.isFailure(seedResult)) {
                  // No manual `rollbackStart` here — the outer
                  // `Effect.onError` below rolls back on this failure too.
                  return yield* Effect.fail(seedResult.failure);
                }
              }
            }
            // Downgrade to a warning and fall through to the success path, no rollback.
            yield* output.raw(`${healthWarningText(error)}\n`, "stderr");
          } else {
            // No manual `rollbackStart` here — the outer `Effect.onError`
            // below rolls back on this failure too.
            return yield* Effect.fail(error);
          }
        }

        // 10. Storage-bucket seeding, gated on `isFreshVolume &&
        // storageContainerId !== undefined` — only when the Postgres data
        // volume was freshly created this run AND Storage actually started.
        // Reached only on a genuine health-check SUCCESS
        // (`Result.isSuccess`): unreachable on the `--ignore-health-check`
        // downgrade-to-warning fallthrough — that fallthrough still fails
        // with the original unhealthy error before ever reaching it
        // (mutually exclusive with the narrower storage-only recheck-and-seed
        // path implemented above, inside the `Result.isFailure(healthResult)`
        // branch: that branch only runs when this one's
        // `Result.isSuccess(healthResult)` guard is false).
        //
        // A seeding failure propagates as a normal command failure and
        // still rolls back via the same outer `Effect.onError` as
        // everything else in this tail: a plain seed error (unlike the
        // health-check timeout above) never satisfies
        // `isUnhealthyStartError`, so it always takes that branch
        // regardless of `--ignore-health-check`.
        if (Result.isSuccess(healthResult) && isFreshVolume && storageContainerId !== undefined) {
          yield* seedBucketsRun({
            projectRef: "",
            emitSummary: false,
            interactive: false,
            yes: true,
            resolvedConfig: {
              config: effectiveLocalStorageConfig,
              document: context.loaded?.document,
            },
            projectEnvValues,
          });
        }

        // 11. Success ONLY: fire `cli_stack_started` exactly once, no
        // properties/groups — this capture sits AFTER the entire
        // bulk-health-check block (including the ignore-health-check
        // downgrade path above), so a genuine bulk-health-check failure
        // never reaches it even when `--ignore-health-check` downgrades it
        // to a warning.
        if (Result.isSuccess(healthResult)) {
          yield* analytics.capture(EventStackStarted, {});
        }
      }).pipe(
        Effect.onError(() =>
          rollbackStart(spawner, filterValue, isFreshVolume, cliSettings.workdir, debug),
        ),
      );
    }

    // The final status render trusts "config-enabled + not --exclude'd" as
    // a proxy for "actually running" — true whenever this line is reached
    // normally (it would have already failed and rolled back before
    // getting here if any enabled, non-excluded container failed to
    // start). The one exception: an IGNORED Postgres health-check timeout
    // (`bringUpResult.kind === "postgresUnhealthyIgnored"` above) reaches
    // this same tail even though every OTHER enabled, non-excluded
    // container was never even created — the status render shows them
    // anyway, purely from config, with no Docker query to contradict it.
    // Edge Runtime now genuinely starts under that same "config-enabled"
    // gate (no more force-exclusion from status rendering), so the raw
    // `--exclude` values are enough on their own.
    const statusExcluded = flags.exclude;

    if (output.format === "text") {
      yield* output.raw(startCompletedMessage(), "stderr");
      // Called DIRECTLY, unlike the already-running branch's `status.Run`: no
      // re-health-check, no "stopped services" diffing, just the raw
      // `--exclude` values against the config/values already resolved (and
      // just health-checked) above. `values` is passed through as
      // `precomputedLocal` so this reuses the exact keys already baked into
      // the containers `bringUp` just created, instead of re-deriving them.
      const { values: statusValues, names } = yield* buildStatusValues(statusExcluded, values);
      yield* output.raw(renderStatusPretty(statusValues, names));
      yield* output.raw(startSecurityNotice(), "stderr");
    } else {
      const { values: statusValues } = yield* buildStatusValues(statusExcluded, values);
      yield* output.success("", statusValues);
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});

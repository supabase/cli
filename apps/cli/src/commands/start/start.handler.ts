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

/** The analytics API key's only possible value; never configurable. */
const ANALYTICS_API_KEY = "api-key";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps a synchronous `envOverride*` config read that throws on a malformed value into a typed
 * `StartInvalidConfigError`, so a bad override fails the command through the normal error path
 * instead of surfacing as an untyped Effect defect.
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
 * Every value {@link buildGotrueContainerSpec} needs from `config`/`values`, minus
 * `dbHost`/`dbPassword` (derived by that builder itself).
 *
 * A configured `auth.signing_keys_path` is honored for anon/service_role JWT signing, for the
 * stack-wide JWKS document, and here as `GOTRUE_JWT_KEYS` — all three resolve the same file via
 * {@link resolveConfiguredSigningKeys}, so GoTrue always signs with a key the published JWKS
 * advertises. `undefined` (the default ES256 key) only when no `signing_keys_path` is configured
 * or auth is disabled.
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
  // Reading the schema-decoded `config.auth.email.smtp` here would always see `enabled: false`
  // when the key is merely absent from the TOML table, silently falling back to Mailpit even when
  // a real SMTP server is configured. `resolveAuthEmailSmtp` resolves this correctly off the raw
  // document.
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
  // Same override gap as `inbucketEnabled` above; these are value-typed fields, so no
  // raw-document presence gate is needed.
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
 * Existence/readability check for one already-resolved `content_path`. Without it, a
 * resolved-but-never-read path (e.g. a missing file, only reachable when `auth.enabled = false`)
 * would reach Docker unverified — the root-privileged daemon silently creates a directory at a
 * bind-mounted host path that doesn't exist, instead of failing.
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
 * Kong's email template mounts: every configured template, then every enabled notification,
 * suffixed `_notification`. Resolves, containment-checks, and read-verifies each `content_path`
 * once, here, before any Docker work; the caller threads the resulting `resolvedPath` straight
 * into the Kong container spec instead of re-deriving it later, closing the TOCTOU window before
 * Kong's own `docker create` call.
 *
 * Skips (never throws for) an entry whose resolver returns `undefined`, defensively, even though
 * that should be unreachable since Kong's set is built from configured entries.
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
 * What `--ignore-health-check` prints when it downgrades a health-check timeout to a warning.
 * Writes straight to stderr, bypassing the `Output.fail` renderer, so it appends the error's
 * `suggestion` itself.
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

    // 1. `--exclude` validation runs before config loads or the already-running check, so this
    // warning fires on every invocation with an invalid `--exclude` value. `excludedKeys` (the
    // valid subset) is what actually gates container bring-up later.
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
    // Resolved here (project `.env` aware) so it can be threaded through to `startDatabase`'s
    // own `setup.experimental` below.
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
    // Kong mounts every configured template and every enabled notification's `content_path`,
    // regardless of `auth.enabled` — see {@link resolveKongEmailTemplateMounts} for why this
    // resolves and verifies each path once, here, rather than re-deriving it before Kong's
    // `docker create` call.
    const kongEmailTemplateMounts = yield* Effect.try({
      try: () => resolveKongEmailTemplateMounts(resolvedEmail, cliSettings.workdir),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    // Duration fields (Go duration syntax) are otherwise only parsed inside GoTrue's own env
    // builder, which never runs when auth is disabled or `gotrue` is excluded — so a malformed
    // value must be validated eagerly here or it would be silently accepted.
    const gotrueSessionsForValidation = resolveGotrueSessions(
      config.auth.sessions,
      projectEnvValues,
    );
    yield* wrapConfigOverride("auth.email.max_frequency", () =>
      parseGoDuration(resolvedEmail.max_frequency),
    );
    // `resolveLocalConfigValues`'s own SMS validation only runs when auth is enabled, so this is
    // the only place a malformed `auth.sms.*` override is caught when auth is disabled.
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
    // `resolveAuthSms` already downgrades `enable_signup` when no provider is enabled; this only
    // detects whether that branch fired, to print the matching warning.
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
    // These GoTrue overrides must validate unconditionally too, regardless of
    // `auth.enabled`/`--exclude gotrue`. The resolvers already throw internally on a bad
    // override, so calling each once here is simpler than re-deriving every field individually.
    yield* wrapConfigOverride("auth.rate_limit", () =>
      resolveGotrueRateLimit(config.auth.rate_limit, projectEnvValues),
    );
    yield* wrapConfigOverride("auth.web3", () =>
      resolveGotrueWeb3(config.auth.web3, projectEnvValues),
    );
    yield* wrapConfigOverride("auth.oauth_server", () =>
      resolveGotrueOAuthServer(config.auth.oauth_server, projectEnvValues),
    );
    // Same gap for the raw (unmodeled by `@supabase/config`) `auth.passkey`/`auth.webauthn`/
    // `auth.external.<name>` booleans, which are otherwise only reached once auth is enabled and
    // gotrue isn't excluded.
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
    // Same gap for `auth.third_party.<provider>.*` — `resolveThirdPartyProviders` is otherwise
    // never called by this handler at all, so a malformed override would never fail the command.
    yield* wrapConfigOverride("auth.third_party", () =>
      resolveThirdPartyProviders(config.auth.third_party, projectEnvValues),
    );
    // `[functions.<slug>.env]` has no supported meaning for `start`, so any key here must be
    // rejected before any Docker work. `@supabase/config`'s schema still models this table for
    // other consumers, so the rejection is CLI-side, not a schema change.
    for (const [slug, func] of Object.entries(config.functions)) {
      if (Object.keys(func.env).length > 0) {
        yield* Effect.fail(
          new StartInvalidConfigError({
            message: `failed to parse config: decoding failed due to the following error(s):\n\n'functions[${slug}]' has invalid keys: env`,
          }),
        );
      }
    }
    // Must run unconditionally, before any Docker work: without this, a malformed
    // `SUPABASE_DB_SEED_ENABLED` or an undecryptable `[db.vault]` secret would go unvalidated
    // whenever `start` reuses an existing volume instead of provisioning a fresh one.
    // `startSetupLocalDatabase` still resolves its own fresh-setup values independently when it runs.
    const dbTomlValues = yield* checkDbToml(fs, path, cliSettings.workdir);

    const dbContainerId = localDbContainerId(projectId);
    const filterValue = cliProjectFilterValue(projectId);

    // Shared by the already-running branch (full status pipeline, re-health-checked) and the
    // success path (a direct pretty-print, no re-health-check).
    //
    // `precomputedLocal` is passed only by the success path, which must reuse the same `values`
    // already used to build every container spec instead of re-deriving them a second time — for
    // asymmetric JWTs, a second derivation would re-sign with a new `exp`. See
    // {@link resolveStatusLocalState}'s `precomputedLocal` param for why that's unsafe.
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

    // 3. A missing container proceeds to startup; other inspect failures propagate. Stopped
    // stacks are recovered unless Bitbucket's lack of named volumes makes removal destructive.
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
      // Gated on text mode for consistency with every other supplementary stderr line this
      // handler prints — json/stream-json callers get a clean structured payload with no noise.
      if (output.format === "text") {
        yield* output.raw(startAlreadyRunningMessage(), "stderr");
      }

      // The full status pipeline for this branch: health-check plus "stopped services" diffing,
      // distinct from the success path's direct pretty-print call below.
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
        // Distinct from, and stacks with, `startAlreadyRunningMessage()` above.
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

    // 4. No update-suggestion check: `start` has no Management API dependency by design.

    // 5. Gate evaluation — see `start.gates.ts`. Wrapped because `envOverrideBool` throws
    // synchronously on an unparsable value, and this handler surfaces that as a typed error.
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

    // 6. JWKS resolution runs unconditionally, before any image pull, regardless of which
    // services end up enabled.
    const jwks = yield* Effect.tryPromise({
      try: () => resolveLocalJwks(config, cliSettings.workdir, values.jwtSecret, projectEnvValues),
      catch: (cause) =>
        new StartInvalidConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // The `edge_runtime.deno_version` -> image switch is start-only (no `db start` equivalent),
    // so it's resolved here rather than inside the shared bootstrap-config derivation below.
    const denoVersion = envOverrideDenoVersion(config.edge_runtime.deno_version, projectEnvValues);

    // Every field the fresh-DB bootstrap needs, shared with `db start`'s own native bootstrap —
    // see `bootstrap-config.ts`'s header for why this is one shared derivation.
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

    // 7. Resolve every image that will actually be pulled before any container is created.
    const imagePlan = resolveStartImagePlan(gates, serviceVersionOverrides);
    // Edge Runtime doesn't go through `resolveStartImagePlan` (see `start.gates.ts`'s header),
    // so its default image is resolved independently, pre-pulled when enabled and not excluded.
    const edgeRuntimeDefaultImage = gates.edgeRuntime
      ? yield* resolveEdgeRuntimeImage(fs, path, cliSettings.workdir, denoVersion)
      : undefined;
    // Pre-pull only touches non-excluded services; the one-shot setup-job images are resolved
    // lazily, only when the fresh-DB setup job actually runs.
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

    // Studio's bind mounts are resolved unconditionally of `config.edge_runtime.enabled`, since
    // `buildSpecForService`'s "studio" case needs them regardless of whether Edge Runtime itself
    // is enabled.
    //
    // `config.functions.<slug>.env.<VAR>` is schema-marked deferred and only gets its literal
    // interpolated by `resolveCliConfigSubtree` — without this, a configured `env` entry reaches
    // Edge Runtime as the literal string `"env(API_KEY)"` instead of the real secret.
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
      // `search: false`: `cliSettings.workdir` is already the fully-resolved chdir target.
      // Climbing ancestors again here could let an unrelated ancestor project's
      // `supabase/functions` win when `--workdir` points at a subdirectory with no config of its own.
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

    // `--network-id` wins over the generated `supabase_network_<project>` fallback, falling back
    // to `SUPABASE_NETWORK_ID` only when the flag was never passed. See
    // {@link resolveDockerNetworkMode} for the full flag/env precedence.
    const networkIdFlag = yield* NetworkIdFlag;
    const networkId = resolveDockerNetworkMode({
      explicit: Option.getOrUndefined(networkIdFlag),
      envOverride: viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnvValues),
      projectId,
    });
    // Linux-only `host.docker.internal:host-gateway` extra host; empty on darwin/windows, where
    // Docker Desktop already resolves that hostname.
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

    // The TLS cert/key disk read is gated on `api.enabled` itself, not just `api.tls.enabled`.
    // Resolved separately from `gates.postgrest`'s own `apiEnabled`, which is additionally
    // combined with `--exclude postgrest` — a distinction config validation has no equivalent for.
    const apiEnabled = yield* wrapConfigOverride("api.enabled", () =>
      envOverrideBool("SUPABASE_API_ENABLED", config.api.enabled, "api.enabled", projectEnvValues),
    );
    // The post-bring-up health-probe CA-trust lookup needs this same env-overridden value, not
    // the raw `config.api.tls.enabled` — both the trust pool and its target URL must read one
    // source of truth.
    const apiTlsEnabled = yield* wrapConfigOverride("api.tls.enabled", () =>
      envOverrideBool(
        "SUPABASE_API_TLS_ENABLED",
        config.api.tls.enabled,
        "api.tls.enabled",
        projectEnvValues,
      ),
    );
    // Same override gap as `apiTlsEnabled` above: the env overrides must apply before reading
    // the cert/key paths from disk.
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

    // Same gap for `storage.vector.enabled` — both the Storage container and `seedBucketsRun`'s
    // config splice further down must see the same already-overridden value.
    const storageVectorEnabled = yield* wrapConfigOverride("storage.vector.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_VECTOR_ENABLED",
        config.storage.vector.enabled,
        "storage.vector.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `storage.s3_protocol.enabled`: the Storage spec builder only parsed this
    // lazily, so a malformed override was silently accepted whenever Storage is excluded/disabled.
    const storageS3ProtocolEnabled = yield* wrapConfigOverride("storage.s3_protocol.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        config.storage.s3_protocol.enabled,
        "storage.s3_protocol.enabled",
        projectEnvValues,
      ),
    );
    // Same gap for `storage.analytics.enabled`. `start` never reads this field itself (only
    // `seed buckets --linked` does), so it's validated here purely for fail-fast parity and the
    // result discarded.
    yield* wrapConfigOverride("storage.analytics.enabled", () =>
      envOverrideBool(
        "SUPABASE_STORAGE_ANALYTICS_ENABLED",
        config.storage.analytics.enabled,
        "storage.analytics.enabled",
        projectEnvValues,
      ),
    );
    // These plain `uint` fields must validate unconditionally too. `start` never reads them
    // itself (only `config push`/`pull` do), so they're validated purely for fail-fast parity.
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

    // Same gap for `api.schemas`/`api.extra_search_path`/`api.max_rows` — both PostgREST's own
    // container and Studio's copy of the same `PGRST_DB_*` env must see the overridden values.
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

    // Same gap for Mailpit's three ports. `smtp_port`/`pop3_port` have no TOML default, so `?? 0`
    // here preserves the "unconfigured" signal `mailpit.service.ts`'s `!== 0` publish guard checks.
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
    // Same gap for Logflare's deprecated `analytics.vector_port`: nothing downstream reads the
    // resolved value, but a malformed override must still fail before any Docker work.
    yield* wrapConfigOverride("analytics.vector_port", () =>
      envOverridePort(
        "SUPABASE_ANALYTICS_VECTOR_PORT",
        config.analytics.vector_port ?? 0,
        "analytics.vector_port",
        projectEnvValues,
      ),
    );

    // Same gap for Supavisor's pooler fields — `pool_mode` specifically decides the published
    // host port (5432 session vs 6543 transaction). Wrapped via `wrapConfigOverride` so a bad
    // value fails as a typed error instead of an untyped Effect defect.
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

    // `edge_runtime.policy`/`edge_runtime.inspector_port` must validate unconditionally too,
    // regardless of `--exclude edge-runtime`. The Edge Runtime branch below re-resolves both
    // against the env-interpolated subtree for the real container build; this eager call only
    // needs the raw config value to prove it parses.
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
     * Every case returns `{ spec, excludeFromHealthWatch? }`. `excludeFromHealthWatch` is
     * returned explicitly rather than a captured mutable variable — only the "vector" case
     * (its `npipe`-scheme exception) ever sets it.
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

    // Set once, inside the pre-create volume-existence check, then read on a rollback. A plain
    // outer `let` is necessary here: `isFreshVolume` must still be readable from `bringUp`'s own
    // failure path (`Effect.onError` below, which runs on any failure including a defect or
    // interrupt), and there's no non-mutable way to thread a value computed mid-effect into a
    // sibling failure handler.
    let isFreshVolume = false;

    // 8. Bring-up order: network -> Postgres (+ health wait, gated on `--ignore-health-check`
    // like every other service below) -> the fresh-volume-gated `SetupLocalDatabase` equivalent,
    // before any other service starts -> the remaining enabled, non-excluded services plus Edge
    // Runtime, in the real start order.
    //
    // Any failure other than an ignored Postgres timeout rolls back and fails the command. An
    // ignored Postgres timeout instead short-circuits to `{ kind: "postgresUnhealthyIgnored" }`
    // below, skipping the rest of this phase and the bulk health check/bucket seeding, but still
    // falling through to the same unconditional "Started..." tail rather than returning early.
    const bringUp = Effect.gen(function* () {
      // Threaded into `setup.debug` below so a failed fresh-volume migrate job tees its own
      // stderr (see `db-setup.ts`'s `runStartMigrateJob`).
      const bringUpDebug = yield* DebugFlag;

      // Runs the DB bootstrap sequence, shared with `db start`'s own native bootstrap — see
      // `startDatabase`'s header for the full call order. `startDatabase` has no knowledge of
      // `--ignore-health-check`; that decision belongs to this caller, immediately below.
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
          // `port`/`settings` bind straight from the already env-overridden
          // `config.db.port`/`config.db.settings`.
          db: {
            ...config.db,
            port: values.dbPort,
            major_version: majorVersion,
            settings: resolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues),
          },
          // Matches the already env-overridden value used to select `postgresImage` above;
          // `postgresExtraEnv` reads this and its sibling S3 fields for its
          // `POSTGRES_INITDB_ARGS` branch.
          experimental: {
            ...config.experimental,
            orioledb_version: orioledbVersion,
            s3_host: s3Host,
            s3_region: s3Region,
            s3_access_key: s3AccessKey,
            s3_secret_key: s3SecretKey,
          },
          jwtSecret: values.jwtSecret,
          // Postgres's `JWT_EXP` and GoTrue's `GOTRUE_JWT_EXP` both read this same
          // already-overridden value; the raw config value would let them disagree.
          jwtExpiry: values.authJwtExpiry,
          projectId,
          networkId,
          configImage: postgresConfigImage,
          rootKey: values.rootKey,
          // `fromBackup` stays unset: `supabase start` always calls the DB
          // bootstrap with an empty `fromBackup` — only `db start` ever sets it.
        },
        // Already resolved as part of this run's batched pre-pull above — `start` has no
        // per-container lazy resolve of its own, unlike `db start`.
        resolvePostgresImage: Effect.succeed(resolveImage(postgresImage)),
        dbHealthTimeoutSeconds,
        webhooksEnabled: dbTomlValues.webhooksEnabled,
        setup: {
          majorVersion,
          experimental,
          // Reads the effective, env-overridden `{Realtime,Storage,Auth}.enabled` values, not
          // additionally filtered by `--exclude` the way `gates.*` is — these one-shot migration
          // jobs run regardless of `--exclude`, since the DB bootstrap finishes before this
          // handler's own excluded-services filtering begins.
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
          // Already resolved unconditionally near the top of this handler (feeding the
          // long-running Realtime/GoTrue/PostgREST containers too), so it's reused, not re-resolved.
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
          // Downgrades to a warning and short-circuits the rest of this phase, falling through
          // to the same unconditional tail every other path reaches.
          yield* output.raw(`${healthWarningText(error)}\n`, "stderr");
          return { kind: "postgresUnhealthyIgnored" as const };
        }
        return yield* Effect.fail(error);
      }

      if (output.format === "text") {
        yield* output.raw(START_STARTING_CONTAINERS_MESSAGE, "stderr");
      }

      // An insertion-ordered container name -> resolved image map. Keyed by name (not the id
      // `docker create` returns) so an unhealthy container reports as `supabase_auth_demo`
      // rather than 64 hex characters, and the watch list stays in sync with its images.
      const started = new Map<string, string>();
      let postgrestGateway: HealthCheckPostgrestGateway | undefined;
      let edgeRuntimeGateway: HealthCheckPostgrestGateway | undefined;
      let storageContainerId: string | undefined;
      const imagePlanByService = new Map(imagePlan.map((entry) => [entry.service, entry.image]));
      for (const entry of START_SERVICES) {
        if (entry.service === "postgres") continue;

        // Edge Runtime doesn't go through `imagePlan`/`buildSpecForService` (see
        // `start.gates.ts`'s header), so it's special-cased here, between ImgProxy and pg-meta.
        if (entry.service === "edgeRuntime") {
          if (!gates.edgeRuntime || edgeRuntimeDefaultImage === undefined) continue;
          // `config.edge_runtime.secrets` is still schema-decoded plain strings here —
          // `toPlainEdgeRuntimeConfig` only emits entries whose values are `Redacted`, which a
          // value only becomes after `resolveCliConfigSubtree`'s env-interpolation and
          // secret-path-redaction pass. Without this step every configured secret is silently
          // dropped.
          const resolvedEdgeRuntime = yield* resolveCliConfigSubtree(
            config.edge_runtime,
            { values: projectEnvValues ?? {} },
            "edge_runtime",
            { goViperCompat: true },
          );
          // Every `config.Secret`-typed field must be decrypted unconditionally so the Edge
          // Runtime container receives plaintext. `toPlainEdgeRuntimeConfig` only interpolates
          // `env()` and unwraps `Redacted` — it never decrypts a dotenvx `encrypted:` value, so
          // without this step the literal ciphertext would reach the container's env file.
          // `checkDbToml` already validates every secret is decryptable, but discards the
          // decrypted plaintext there.
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
          // Not calling `runtime.cleanup` here: unlike every other service (`createContainer`'s
          // `restartPolicy: "unless-stopped"`), Edge Runtime sets no Docker restart policy, so
          // its bind-mounted host temp files must still exist for as long as the container can
          // be reattached to. `startStackEdgeRuntimeContainer` already runs cleanup internally on
          // a failed or interrupted bring-up, so only the success path must leave it alone.
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

        // Defense-in-depth: some service builders do synchronous, throwing work over config
        // fields `@supabase/config`'s schema doesn't itself validate (most such fields are now
        // caught earlier, eagerly, above). A malformed value would otherwise surface as an
        // uncaught Effect defect — `Effect.onError` below still rolls back either way, but
        // `catchDefect` converts it into the same typed config error every other malformed-config
        // path produces, instead of an opaque defect.
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
      // The rollback's `NoBackupVolume` value is `true` only when this run's Postgres volume was
      // freshly created — a rollback prunes volumes on a first-ever `start`, but never touches a
      // pre-existing user's data on a failed restart.
      //
      // `Effect.onError`, not `Effect.tapError`: this must roll back on any failure from bring-up,
      // including a SIGINT interrupt. `tapError` is built on `Cause.findError`, which only
      // matches `Fail` reasons — a pure fiber interrupt never reaches it.
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

    // Only reached when Postgres itself became healthy — the `postgresUnhealthyIgnored`
    // short-circuit above skips this entire block and falls through to the tail below instead.
    if (bringUpResult.kind === "started") {
      const { started, postgrestGateway, edgeRuntimeGateway, storageContainerId } = bringUpResult;

      // Wraps steps 9-11 below in the same `Effect.onError` rollback `bringUp`'s own pipe uses
      // above, so a SIGINT/SIGTERM landing anywhere in this tail also rolls back. Per-step manual
      // `rollbackStart` calls would miss a pure fiber interrupt between steps (see the `bringUp`
      // pipe's comment for why `onError`, not `tapError`, is required).
      yield* Effect.gen(function* () {
        // 9. Bulk health check over every non-Postgres started container, at
        // the generic 30s service timeout.
        if (output.format === "text") {
          yield* output.raw(START_WAITING_FOR_HEALTH_CHECKS_MESSAGE, "stderr");
        }
        // PostgREST/Edge Runtime readiness probes go through Kong over HTTP(S); when
        // `api.tls.enabled`, Kong's cert is self-signed, so the default `HttpClient` would fail
        // TLS verification and the health check would time out even though the services are
        // healthy. Overrides only the underlying `FetchHttpClient.Fetch` primitive, so it's a
        // no-op against a mock `HttpClient` (this file's own tests).
        //
        // `effectiveLocalStorageConfig` folds the hoisted, env-overridden api/auth/storage values
        // into `config` rather than the raw config, so every consumer below sees the exact
        // resolved port/TLS/cert/secrets the real containers were started with. Reused for both
        // this CA lookup and the two `seedBucketsRun` calls below, so bucket seeding never
        // independently reloads config and drops these overrides.
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
            // Gates only this wait, not Postgres's own earlier one. Additionally, when it's a
            // fresh volume and Storage was among the started containers, wait for Storage alone
            // and seed buckets if it becomes healthy. A seed failure there replaces this health
            // error and hard-fails (a plain seed error never satisfies `isUnhealthyStartError`,
            // so it skips this branch's own downgrade-to-warning). A seed success, or a storage
            // recheck that never turns healthy, falls through to the same downgrade-to-warning.
            if (isFreshVolume && storageContainerId !== undefined) {
              // `images` is the whole run's registry, not scoped to this one-container watch
              // list — the hint can only key off containers that appear in this call's own failures.
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

        // 10. Storage-bucket seeding, gated on a freshly created volume and Storage having
        // started. Reached only on a genuine health-check success — mutually exclusive with the
        // narrower storage-only recheck-and-seed path above, which only runs when this guard is
        // false.
        //
        // A seeding failure rolls back via the same outer `Effect.onError`: a plain seed error
        // never satisfies `isUnhealthyStartError`, so it always fails regardless of
        // `--ignore-health-check`.
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

        // 11. Fires `cli_stack_started` exactly once, only on success. Sits after the entire
        // bulk-health-check block, so a genuine failure never reaches it even when
        // `--ignore-health-check` downgrades it to a warning.
        if (Result.isSuccess(healthResult)) {
          yield* analytics.capture(EventStackStarted, {});
        }
      }).pipe(
        Effect.onError(() =>
          rollbackStart(spawner, filterValue, isFreshVolume, cliSettings.workdir, debug),
        ),
      );
    }

    // The final status render trusts "config-enabled and not --exclude'd" as a proxy for
    // "actually running", since a real failure would have already rolled back before reaching
    // here. The exception: an ignored Postgres health-check timeout reaches this same tail even
    // though every other container was never created — the status render shows them anyway,
    // purely from config, with no Docker query to contradict it.
    const statusExcluded = flags.exclude;

    if (output.format === "text") {
      yield* output.raw(startCompletedMessage(), "stderr");
      // Unlike the already-running branch, no re-health-check or "stopped services" diffing —
      // just the raw `--exclude` values against the config already resolved above. `values` is
      // passed as `precomputedLocal` so this reuses the exact keys already baked into the
      // containers `bringUp` just created.
      const { values: statusValues, names } = yield* buildStatusValues(statusExcluded, values);
      yield* output.raw(renderStatusPretty(statusValues, names));
      yield* output.raw(startSecurityNotice(), "stderr");
    } else {
      const { values: statusValues } = yield* buildStatusValues(statusExcluded, values);
      yield* output.success("", statusValues);
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});

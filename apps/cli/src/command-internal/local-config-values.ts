import type { CliConfig } from "@supabase/config";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  DEFAULT_LOCAL_S3_REGION,
  DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "@supabase/stack/defaults";
import { defaultPublishableKey, defaultSecretKey } from "../shared/stack-constants.ts";
import { Effect, Option, Schema } from "effect";
import * as Base64Url from "effect/encoding/Base64Url";

import {
  resolveRemoteJwks,
  resolveThirdPartyIssuerUrl,
  thirdPartyIssuerUrlUnchecked,
  toPublicJwk,
} from "../shared/auth/jwks.ts";
import { resolveApiExternalUrl } from "./api-url.ts";
import { sanitizeProjectId } from "../shared/config/project-id.ts";
import {
  makeCliConfigUnitIo,
  runConfigUnitsFirst,
  untrackedCliConfigView,
  type CliConfigUnitIo,
} from "./config-check-core.ts";
import { authDurationUnits } from "./config-check-auth-units.ts";
import { LOCAL_CHECK_ORDER } from "./config-check-units.ts";
import {
  authExternalProviderNames,
  HOOK_TYPE_ORDER,
  rawOrigins,
  readSigningKeys,
} from "./local-config-helpers.ts";
import {
  ConfigValidateError,
  narrowConfigEnum,
  rawUnmodeledBool,
  resolveJwtSecret,
  resolveSignedKey,
  thrownError,
} from "./config-validate.ts";
import { DEFAULT_SIGNING_KEY, type Jwk } from "./local-jwt.ts";

interface CaptchaInput {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly secret: string | undefined;
}

interface SmtpInput {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly adminEmail: string;
}

interface ThirdPartyInput {
  readonly provider: "firebase" | "auth0" | "cognito" | "clerk" | "workos";
  readonly requiredField: string;
  readonly cognitoUserPoolRegion?: string;
}

/**
 * Resolves local-dev config values (URLs, ports, keys) from the effective config the
 * `CliConfigValues` resolved config materializes: every flag, environment, project `.env*` and matched
 * `[remotes.*]` winner is already in `config`, and `document` is the matching effective document
 * (see `effectiveConfigDocument`), so nothing here re-applies precedence.
 */

const DEFAULT_DB_PASSWORD = DEFAULT_LOCAL_DATABASE_PASSWORD;

const DEFAULT_S3_ACCESS_KEY_ID = DEFAULT_LOCAL_S3_ACCESS_KEY_ID;
const DEFAULT_S3_SECRET_ACCESS_KEY = DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY;
const DEFAULT_S3_REGION = DEFAULT_LOCAL_S3_REGION;

/** Shared with `start`'s Postgres container-spec builder. */
export const POSTGRES_DEFAULT_ROOT_KEY = DEFAULT_POSTGRES_ROOT_KEY;

export interface LocalConfigValues {
  readonly apiUrl: string;
  readonly apiPort: number;
  readonly dbPort: number;
  readonly studioPort: number;
  readonly rootKey: string;
  readonly openaiApiKey: string | undefined;
  readonly authSiteUrl: string;
  readonly authJwtIssuer: string | undefined;
  readonly authJwtExpiry: number;
  readonly authAdditionalRedirectUrls: ReadonlyArray<string>;
  readonly authEnableSignup: boolean;
  readonly authEnableAnonymousSignIns: boolean;
  readonly authEnableRefreshTokenRotation: boolean;
  readonly authRefreshTokenReuseInterval: number;
  readonly authEnableManualLinking: boolean;
  readonly authMinimumPasswordLength: number;
  readonly authPasswordRequirements: string;
  readonly restUrl: string;
  readonly graphqlUrl: string;
  readonly functionsUrl: string;
  readonly mcpUrl: string;
  readonly studioUrl: string;
  readonly mailpitUrl: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtSecret: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly storageS3Url: string;
  readonly storageS3AccessKeyId: string;
  readonly storageS3SecretAccessKey: string;
  readonly storageS3Region: string;
  readonly analyticsEnabled: boolean;
  readonly analyticsBackend: "postgres" | "bigquery";
  readonly gcpProjectId: string;
  readonly gcpProjectNumber: string;
  readonly gcpJwtPath: string;
  /** Sanitized project ID, exposed so callers naming Docker resources don't re-derive it. */
  readonly projectId: string;
  readonly edgeRuntimeDenoVersion: number;
}

/** Appends `path` to the resolved external URL; `apiExternalUrl` is always already defaulted. */
function apiUrlWithPath(apiExternalUrl: string, path: string): string {
  return `${apiExternalUrl}${path}`;
}

const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: thrownError });

/** Narrows an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Resolves `[auth.email.smtp]`'s full field set, including a presence-based `enabled`
 * default `@supabase/config`'s schema can't express (it always decodes `enabled: false`
 * when the key is absent from a present table).
 */
export function resolveAuthEmailSmtp(
  authDocument: Readonly<Record<string, unknown>> | undefined,
): (SmtpInput & { readonly senderName: string | undefined }) | undefined {
  const smtpDoc = asRecord(asRecord(authDocument?.["email"])?.["smtp"]);
  if (smtpDoc === undefined) return undefined;
  return {
    enabled: smtpDoc["enabled"] === undefined ? true : smtpDoc["enabled"] === true,
    host: asString(smtpDoc["host"]) ?? "",
    port: typeof smtpDoc["port"] === "number" ? smtpDoc["port"] : 0,
    user: asString(smtpDoc["user"]) ?? "",
    pass: asString(smtpDoc["pass"]) ?? "",
    adminEmail: asString(smtpDoc["admin_email"]) ?? "",
    senderName: asString(smtpDoc["sender_name"]),
  };
}

/**
 * `config.auth.captcha` never decodes to `undefined` when `[auth.captcha]` is absent, so
 * callers that need presence read the document; this only reshapes the effective value.
 */
export function resolveAuthCaptcha(
  captcha: CliConfig["auth"]["captcha"],
): CaptchaInput | undefined {
  return captcha
    ? { enabled: captcha.enabled ?? false, provider: captcha.provider, secret: captcha.secret }
    : undefined;
}

function resolveOpaqueKey(configured: string | undefined, fallback: string): string {
  return configured !== undefined && configured.length > 0 ? configured : fallback;
}

/**
 * Returns the parsed signing keys only when auth is enabled and a path is configured;
 * `undefined` otherwise, so callers fall back to their own default key shape. Shared by
 * {@link resolveLocalJwks} and `start.handler.ts`'s `GOTRUE_JWT_KEYS` so both resolvers agree
 * on which key(s) apply.
 */
export const resolveConfiguredSigningKeys = Effect.fnUntraced(function* (
  config: CliConfig,
  workdir: string,
  io?: CliConfigUnitIo,
) {
  const signingKeysPath = config.auth.signing_keys_path;
  if (!config.auth.enabled || signingKeysPath === undefined || signingKeysPath.length === 0) {
    return undefined;
  }
  return yield* readSigningKeys(
    io ?? (yield* makeCliConfigUnitIo("local")),
    workdir,
    signingKeysPath,
  );
});

/**
 * One `[auth.email.template.<name>]` entry. `subject` is `string | undefined` rather than a plain
 * `string` — see {@link resolveAuthEmail} for why.
 */
interface ResolvedAuthEmailTemplate {
  readonly subject: string | undefined;
  readonly content_path: string;
  readonly content_present: boolean;
}

/** One `[auth.email.notification.<name>]` entry — see {@link ResolvedAuthEmailTemplate}. */
interface ResolvedAuthEmailNotification {
  readonly enabled: boolean;
  readonly subject: string | undefined;
  readonly content_path: string;
  readonly content_present: boolean;
}

/**
 * {@link resolveAuthEmail}'s return type — identical to `CliConfig["auth"]["email"]`
 * except each `template`/`notification` entry's `subject` is `string | undefined` instead of a
 * plain `string`.
 */
export type ResolvedAuthEmail = Omit<CliConfig["auth"]["email"], "template" | "notification"> & {
  readonly template: Readonly<Record<string, ResolvedAuthEmailTemplate>>;
  readonly notification: Readonly<Record<string, ResolvedAuthEmailNotification>>;
};

/**
 * Adds per-`template`/`notification` presence facts to the effective `auth.email`. The document
 * tells an explicit `subject = ""` apart from an absent key (both decode to `""`), and whether
 * `content` is set at all.
 */
export function resolveAuthEmail(
  email: CliConfig["auth"]["email"],
  authDocument: Record<string, unknown> | undefined,
): ResolvedAuthEmail {
  const emailDoc = asRecord(authDocument?.["email"]);
  const templateDoc = asRecord(emailDoc?.["template"]);
  const notificationDoc = asRecord(emailDoc?.["notification"]);

  const template: Record<string, ResolvedAuthEmailTemplate> = {};
  for (const [name, tmpl] of Object.entries(email.template)) {
    const entry = asRecord(templateDoc?.[name]);
    template[name] = {
      subject: entry?.["subject"] !== undefined ? tmpl.subject : undefined,
      content_path: tmpl.content_path,
      content_present: entry?.["content"] !== undefined,
    };
  }

  const notification: Record<string, ResolvedAuthEmailNotification> = {};
  for (const [name, tmpl] of Object.entries(email.notification)) {
    const entry = asRecord(notificationDoc?.[name]);
    notification[name] = {
      enabled: tmpl.enabled,
      subject: entry?.["subject"] !== undefined ? tmpl.subject : undefined,
      content_path: tmpl.content_path,
      content_present: entry?.["content"] !== undefined,
    };
  }

  return { ...email, template, notification };
}

/** The effective `db.settings`, never `undefined` so callers can read fields directly. */
export function resolveDbSettingsEnvOverrides(
  settings: CliConfig["db"]["settings"],
): NonNullable<CliConfig["db"]["settings"]> {
  return settings ?? {};
}

/** Resolves `auth.external_url`, which the schema doesn't model, from the effective document. */
export function resolveAuthExternalUrl(
  document: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return asString(asRecord(document?.["auth"])?.["external_url"]);
}

/** camelCase key {@link resolveAuthHooks} exposes per {@link HOOK_TYPE_ORDER} entry, matching `gotrue.service.ts`'s env-input field names. */
const HOOK_TYPE_TO_CAMEL = {
  mfa_verification_attempt: "mfaVerificationAttempt",
  password_verification_attempt: "passwordVerificationAttempt",
  custom_access_token: "customAccessToken",
  send_sms: "sendSms",
  send_email: "sendEmail",
  before_user_created: "beforeUserCreated",
} as const satisfies Record<(typeof HOOK_TYPE_ORDER)[number], string>;

interface ResolvedAuthHook {
  readonly enabled: boolean;
  readonly uri: string;
  readonly secrets: string;
}

export type ResolvedAuthHooks = {
  readonly [K in (typeof HOOK_TYPE_TO_CAMEL)[keyof typeof HOOK_TYPE_TO_CAMEL]]: ResolvedAuthHook;
};

/** Reshapes the effective `auth.hook.<type>` entries, with absent `uri`/`secrets` as `""`. */
export function resolveAuthHooks(hook: CliConfig["auth"]["hook"]): ResolvedAuthHooks {
  const result = {} as Record<string, ResolvedAuthHook>;
  for (const hookType of HOOK_TYPE_ORDER) {
    const h = hook[hookType];
    result[HOOK_TYPE_TO_CAMEL[hookType]] = {
      enabled: h.enabled,
      uri: h.uri ?? "",
      secrets: h.secrets ?? "",
    };
  }
  return result as ResolvedAuthHooks;
}

/** The effective `auth.mfa`. */
export function resolveAuthMfa(mfa: CliConfig["auth"]["mfa"]): CliConfig["auth"]["mfa"] {
  return mfa;
}

/** The effective `auth.rate_limit`. */
export function resolveGotrueRateLimit(
  rateLimit: CliConfig["auth"]["rate_limit"],
): CliConfig["auth"]["rate_limit"] {
  return rateLimit;
}

/** The effective `auth.sessions`. */
export function resolveGotrueSessions(
  sessions: CliConfig["auth"]["sessions"],
): CliConfig["auth"]["sessions"] {
  return sessions;
}

/**
 * Reads `auth.passkey`/`auth.webauthn`, which have no `@supabase/config` schema fields: presence
 * and every field come from the effective document. An absent section stays absent.
 */
export function resolveGotruePasskeyWebauthn(
  document: Readonly<Record<string, unknown>> | undefined,
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
      ? rawUnmodeledBool(passkeyDoc["enabled"], "auth.passkey.enabled")
      : undefined;
  const webauthn =
    webauthnDoc !== undefined
      ? {
          rpId: asString(webauthnDoc["rp_id"]) ?? "",
          rpDisplayName: asString(webauthnDoc["rp_display_name"]) ?? "",
          rpOrigins: rawOrigins(webauthnDoc["rp_origins"]) ?? [],
        }
      : undefined;
  return { passkeyEnabled, webauthn };
}

/** The effective `auth.web3`. */
export function resolveGotrueWeb3(web3: CliConfig["auth"]["web3"]): CliConfig["auth"]["web3"] {
  return web3;
}

/** The effective `auth.oauth_server`. */
export function resolveGotrueOAuthServer(
  oauthServer: CliConfig["auth"]["oauth_server"],
): CliConfig["auth"]["oauth_server"] {
  return oauthServer;
}

/** Lists enabled `auth.third_party.<provider>` entries in a fixed order, with their required fields. */
export function resolveThirdPartyProviders(
  thirdParty: CliConfig["auth"]["third_party"],
): ReadonlyArray<ThirdPartyInput> {
  const resolved: Array<ThirdPartyInput> = [];
  if (thirdParty.firebase.enabled) {
    resolved.push({ provider: "firebase", requiredField: thirdParty.firebase.project_id ?? "" });
  }
  if (thirdParty.auth0.enabled) {
    resolved.push({ provider: "auth0", requiredField: thirdParty.auth0.tenant ?? "" });
  }
  if (thirdParty.aws_cognito.enabled) {
    resolved.push({
      provider: "cognito",
      requiredField: thirdParty.aws_cognito.user_pool_id ?? "",
      cognitoUserPoolRegion: thirdParty.aws_cognito.user_pool_region,
    });
  }
  if (thirdParty.clerk.enabled) {
    resolved.push({ provider: "clerk", requiredField: thirdParty.clerk.domain ?? "" });
  }
  if (thirdParty.workos.enabled) {
    resolved.push({ provider: "workos", requiredField: thirdParty.workos.issuer_url ?? "" });
  }
  return resolved;
}

/**
 * The effective `auth.sms`. Phone signup is never enabled when no provider is configured to
 * deliver an OTP, and twilio's two required ids default to `""`.
 */
export function resolveAuthSms(sms: CliConfig["auth"]["sms"]): CliConfig["auth"]["sms"] {
  const anyProviderEnabled =
    sms.twilio.enabled ||
    sms.twilio_verify.enabled ||
    sms.messagebird.enabled ||
    sms.textlocal.enabled ||
    sms.vonage.enabled;
  return {
    ...sms,
    enable_signup: anyProviderEnabled ? sms.enable_signup : false,
    twilio: {
      ...sms.twilio,
      account_sid: sms.twilio.account_sid ?? "",
      message_service_sid: sms.twilio.message_service_sid ?? "",
    },
  };
}

type ValueOf<T> = T[keyof T];

/** Matches `GotrueExternalProviderInput`'s fields, kept separate to avoid a command-specific import. */
export interface ResolvedAuthExternalProvider {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly secret?: string;
  readonly url: string;
  readonly redirectUri?: string;
  readonly skipNonceCheck: boolean;
  readonly emailOptional: boolean;
}

function resolveExternalProvider(
  name: string,
  provider: ValueOf<CliConfig["auth"]["external"]> | undefined,
  rawProvider: Readonly<Record<string, unknown>> | undefined,
): ResolvedAuthExternalProvider {
  return {
    enabled:
      provider?.enabled ??
      rawUnmodeledBool(rawProvider?.["enabled"], `auth.external.${name}.enabled`),
    clientId: provider?.client_id ?? asString(rawProvider?.["client_id"]) ?? "",
    secret: provider?.secret ?? asString(rawProvider?.["secret"]),
    url: provider?.url ?? asString(rawProvider?.["url"]) ?? "",
    redirectUri: provider?.redirect_uri ?? asString(rawProvider?.["redirect_uri"]),
    skipNonceCheck:
      provider?.skip_nonce_check ??
      rawUnmodeledBool(rawProvider?.["skip_nonce_check"], `auth.external.${name}.skip_nonce_check`),
    emailOptional:
      provider?.email_optional ??
      rawUnmodeledBool(rawProvider?.["email_optional"], `auth.external.${name}.email_optional`),
  };
}

/** The provider names `auth.external` resolves: document keys and `apple` that have a decoded or record entry; never throws. */
export function listAuthExternalProviderNames(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  external: CliConfig["auth"]["external"],
): ReadonlyArray<string> {
  const externalDoc = asRecord(authDocument?.["external"]);
  const decoded = new Map(Object.entries(external));
  return authExternalProviderNames(Object.keys(externalDoc ?? {})).filter(
    (name) => decoded.has(name) || asRecord(externalDoc?.[name]) !== undefined,
  );
}

/**
 * Resolves `auth.external.<name>` entries, iterating the effective document's provider names
 * (not just the schema's fixed ~19) since custom providers decode with no schema at all.
 * `apple` is always included, since the default config.toml template registers it
 * uncommented.
 */
export function resolveAuthExternalProviders(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  external: CliConfig["auth"]["external"],
): Record<string, ResolvedAuthExternalProvider> {
  const externalDoc = asRecord(authDocument?.["external"]);
  const decoded = new Map(Object.entries(external));
  const result: Record<string, ResolvedAuthExternalProvider> = {};
  for (const name of listAuthExternalProviderNames(authDocument, external)) {
    const provider = decoded.get(name);
    const rawProvider = provider === undefined ? asRecord(externalDoc?.[name]) : undefined;
    result[name] = resolveExternalProvider(name, provider, rawProvider);
  }
  return result;
}

/** Fails on the first malformed auth duration; only `start` runs this, so `stop` and `status` accept them. */
export const resolveStartAuthDurations = Effect.fnUntraced(function* (
  config: CliConfig,
  workdir: string,
  document?: Readonly<Record<string, unknown>>,
  configPath?: string,
) {
  const io = yield* makeCliConfigUnitIo("local");
  yield* runConfigUnitsFirst(
    authDurationUnits,
    untrackedCliConfigView({ config, document, workdir, configPath }),
    io,
  );
});

/**
 * Fails with the first config error, in the order {@link LOCAL_CHECK_ORDER} runs the checks:
 * `api.tls` file reads, `db.root_key`, `auth.jwt_secret`, signing keys and email content files,
 * then the value and requirement checks, then anon/service_role key generation.
 */
export const resolveLocalConfigValues = Effect.fnUntraced(function* (
  config: CliConfig,
  hostname: string,
  workdir: string,
  /**
   * The effective document `config` was decoded from, for checks that hinge on section presence
   * (not the always-defaulted decoded value). `undefined` callers skip those checks.
   */
  document?: Readonly<Record<string, unknown>>,
  /** The loaded config file's path, so messages name it; `undefined` reads as `config.toml`. */
  configPath?: string,
) {
  const io = yield* makeCliConfigUnitIo("local");
  yield* runConfigUnitsFirst(
    LOCAL_CHECK_ORDER,
    untrackedCliConfigView({ config, document, workdir, configPath }),
    io,
  );

  const resolvedProjectId = config.project_id ?? "";
  const apiPort = config.api.port;
  const apiExternalUrl = resolveApiExternalUrl(
    {
      external_url: config.api.external_url,
      port: apiPort,
      tls: { enabled: config.api.tls.enabled },
    },
    hostname,
  );
  const dbPort = config.db.port;
  const studioPort = config.studio.port;
  const mailpitPort = config.local_smtp.port;
  const rawRootKey = asRecord(document?.["db"])?.["root_key"];
  const rootKey =
    typeof rawRootKey !== "string" || rawRootKey.length === 0
      ? POSTGRES_DEFAULT_ROOT_KEY
      : rawRootKey;
  const jwtSecret = yield* attempt(() => resolveJwtSecret(config.auth.jwt_secret));
  const analyticsBackend = yield* attempt(() =>
    narrowConfigEnum("analytics.backend", config.analytics.backend, ["postgres", "bigquery"]),
  );
  const signingKeysPath = config.auth.signing_keys_path;
  // A disabled-auth config with a configured path must still sign asymmetrically with the
  // default key, not fall back to symmetric HS256.
  const signingKey =
    signingKeysPath !== undefined && signingKeysPath.length > 0
      ? ((yield* resolveConfiguredSigningKeys(config, workdir, io)) ?? [DEFAULT_SIGNING_KEY])[0]
      : undefined;
  const anonKey = yield* attempt(() =>
    resolveSignedKey(config.auth.anon_key, jwtSecret, signingKey, "anon"),
  );
  const serviceRoleKey = yield* attempt(() =>
    resolveSignedKey(config.auth.service_role_key, jwtSecret, signingKey, "service_role"),
  );

  return {
    apiUrl: apiExternalUrl,
    apiPort,
    dbPort,
    studioPort,
    rootKey,
    openaiApiKey: config.studio.openai_api_key,
    authSiteUrl: config.auth.site_url,
    authJwtIssuer: config.auth.jwt_issuer,
    authJwtExpiry: config.auth.jwt_expiry,
    authAdditionalRedirectUrls: config.auth.additional_redirect_urls,
    authEnableSignup: config.auth.enable_signup,
    authEnableAnonymousSignIns: config.auth.enable_anonymous_sign_ins,
    authEnableRefreshTokenRotation: config.auth.enable_refresh_token_rotation,
    authRefreshTokenReuseInterval: config.auth.refresh_token_reuse_interval,
    authEnableManualLinking: config.auth.enable_manual_linking,
    authMinimumPasswordLength: config.auth.minimum_password_length,
    authPasswordRequirements: config.auth.password_requirements,
    restUrl: apiUrlWithPath(apiExternalUrl, "/rest/v1"),
    graphqlUrl: apiUrlWithPath(apiExternalUrl, "/graphql/v1"),
    functionsUrl: apiUrlWithPath(apiExternalUrl, "/functions/v1"),
    mcpUrl: apiUrlWithPath(apiExternalUrl, "/mcp"),
    studioUrl: `http://${hostname}:${studioPort}`,
    mailpitUrl: `http://${hostname}:${mailpitPort}`,
    dbUrl: `postgresql://postgres:${DEFAULT_DB_PASSWORD}@${hostname}:${dbPort}/postgres`,
    publishableKey: resolveOpaqueKey(config.auth.publishable_key, defaultPublishableKey),
    secretKey: resolveOpaqueKey(config.auth.secret_key, defaultSecretKey),
    jwtSecret,
    anonKey,
    serviceRoleKey,
    storageS3Url: apiUrlWithPath(apiExternalUrl, "/storage/v1/s3"),
    storageS3AccessKeyId: DEFAULT_S3_ACCESS_KEY_ID,
    storageS3SecretAccessKey: DEFAULT_S3_SECRET_ACCESS_KEY,
    storageS3Region: DEFAULT_S3_REGION,
    analyticsEnabled: config.analytics.enabled,
    analyticsBackend,
    gcpProjectId: config.analytics.gcp_project_id ?? "",
    gcpProjectNumber: config.analytics.gcp_project_number ?? "",
    gcpJwtPath: config.analytics.gcp_jwt_path ?? "",
    projectId: sanitizeProjectId(resolvedProjectId),
    edgeRuntimeDenoVersion: config.edge_runtime.deno_version,
  } satisfies LocalConfigValues;
});

/** Resolves local and remote signing keys for services that consume the local JWKS document. */
export const resolveLocalJwks = Effect.fnUntraced(function* (
  config: CliConfig,
  workdir: string,
  jwtSecret: string,
) {
  const signingKeysPath = config.auth.signing_keys_path;
  // Every resolved config carries the default ES256 key, regardless of `auth.enabled`. It's
  // only ever replaced by a configured `signing_keys_path` file, and only when that file is
  // actually read (gated on `auth.enabled` — see {@link resolveConfiguredSigningKeys}). So JWKS
  // resolution always publishes either the file's keys or this default, never neither —
  // `GOTRUE_JWT_KEYS` signs with the same default, so the two must never disagree.
  const signingKeys: ReadonlyArray<Jwk> = (yield* resolveConfiguredSigningKeys(
    config,
    workdir,
  )) ?? [DEFAULT_SIGNING_KEY];

  // `resolveThirdPartyIssuerUrl`'s "at most one enabled" + required-field checks are only
  // meaningful while auth is enabled; when auth is disabled they are skipped, so the
  // unchecked, no-throw issuer-url builder applies instead.
  const thirdParty = config.auth.third_party;
  const issuerUrl = Option.fromNullishOr(
    yield* Effect.try({
      try: () =>
        config.auth.enabled
          ? resolveThirdPartyIssuerUrl(thirdParty)
          : thirdPartyIssuerUrlUnchecked(thirdParty),
      catch: (cause) =>
        cause instanceof ConfigValidateError
          ? cause
          : new ConfigValidateError(cause instanceof Error ? cause.message : String(cause)),
    }),
  ).pipe(Option.filter((value) => value.length > 0));
  const keys: unknown[] = [];
  if (Option.isSome(issuerUrl)) {
    keys.push(
      ...(yield* resolveRemoteJwks(issuerUrl.value).pipe(
        Effect.mapError((cause) => new ConfigValidateError(cause.message)),
      )),
    );
  }
  keys.push(...signingKeys.map(toPublicJwk));
  if (signingKeysPath === undefined || signingKeysPath.length === 0) {
    keys.push({ kty: "oct", k: Base64Url.encode(jwtSecret) });
  }
  return yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(Schema.Unknown) })),
  )({ keys }).pipe(Effect.mapError((cause) => new ConfigValidateError(cause.message)));
});

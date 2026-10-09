import { readFileSync } from "node:fs";

import type { CliConfig } from "@supabase/config";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  DEFAULT_LOCAL_S3_REGION,
  DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "@supabase/stack/defaults";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
} from "../shared/stack-constants.ts";
import { Effect, Encoding, Option, Schema } from "effect";

import { CliConfigValueError } from "../config/cli-config.errors.ts";
import {
  resolveRemoteJwks,
  resolveThirdPartyIssuerUrl,
  thirdPartyIssuerUrlUnchecked,
  toPublicJwk,
} from "../shared/auth/jwks.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { resolveApiExternalUrl } from "./api-url.ts";
import { sanitizeProjectId } from "../shared/config/project-id.ts";
import {
  apiTlsCertReadErrorMessage,
  apiTlsKeyReadErrorMessage,
  type AnalyticsInput,
  type ApiInput,
  type AuthInput,
  type CaptchaInput,
  ConfigValidateError,
  type ConfigValidationInput,
  type DbInput,
  emailContentPathReadErrorMessage,
  type ExperimentalInput,
  type HookInput,
  type LocalSmtpInput,
  type MfaFactorInput,
  type PasskeyInput,
  resolveApiTlsPath,
  resolveEmailTemplateContentPath,
  resolveSigningKeysPath,
  signingKeysDecodeErrorMessage,
  signingKeysReadErrorMessage,
  type SmtpInput,
  type StudioInput,
  type ThirdPartyInput,
  validateResolvedConfig,
} from "./config-validate.ts";
import { parseBoolLiteral } from "../shared/config/config-bool.ts";
import {
  DEFAULT_SIGNING_KEY,
  generateAsymmetricLocalJwt,
  generateLocalJwt,
  type Jwk,
} from "./local-jwt.ts";

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

/**
 * Thrown by {@link resolveLocalConfigValues} when `auth.jwt_secret` is configured but too
 * short to sign with. Validated at config-load time, before any command renders output.
 */
export class InvalidJwtSecretError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidJwtSecretError";
  constructor() {
    super("Invalid config for auth.jwt_secret. Must be at least 16 characters");
    this.name = "InvalidJwtSecretError";
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Minimum `auth.jwt_secret` length. */
const MIN_JWT_SECRET_LENGTH = 16;

/** Narrows a configured string to one of `allowed`, failing with the codec wording otherwise. */
export const narrowConfigEnum = <const T extends string>(
  path: string,
  configured: string,
  allowed: ReadonlyArray<T>,
): T => {
  const match = allowed.find((candidate) => candidate === configured);
  if (match === undefined) {
    throw new CliConfigValueError({
      path,
      tier: "config",
      message: `Invalid config for ${path}: "${configured}" must be one of ${allowed
        .map((value) => `"${value}"`)
        .join(", ")}`,
    });
  }
  return match;
};

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

/**
 * Resolves the signing secret from the effective `auth.jwt_secret`: empty falls back to
 * {@link defaultJwtSecret}, shorter than {@link MIN_JWT_SECRET_LENGTH} throws
 * {@link InvalidJwtSecretError}.
 */
export function resolveJwtSecret(configured: string | undefined): string {
  if (configured === undefined || configured.length === 0) return defaultJwtSecret;
  if (configured.length < MIN_JWT_SECRET_LENGTH) {
    throw new InvalidJwtSecretError();
  }
  return configured;
}

function resolveOpaqueKey(configured: string | undefined, fallback: string): string {
  return configured !== undefined && configured.length > 0 ? configured : fallback;
}

function resolveSignedKey(
  configured: string | undefined,
  jwtSecret: string,
  signingKey: Jwk | undefined,
  role: "anon" | "service_role",
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  return signingKey !== undefined
    ? generateAsymmetricLocalJwt(signingKey, role)
    : generateLocalJwt(jwtSecret, role);
}

/** JWK fields, matching {@link Jwk}. */
const JwkSchema = Schema.Struct({
  kty: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
  alg: Schema.optionalKey(Schema.String),
  ext: Schema.optionalKey(Schema.Boolean),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  d: Schema.optionalKey(Schema.String),
  p: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  dp: Schema.optionalKey(Schema.String),
  dq: Schema.optionalKey(Schema.String),
  qi: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
});
const decodeJwks = Schema.decodeUnknownSync(Schema.Array(JwkSchema));

/**
 * Reads and JSON-decodes `signingKeysPath` into an array of {@link Jwk}, using `node:fs`
 * directly (not the `FileSystem` Effect service) to keep this a plain synchronous resolver
 * for a rarely-configured field. Callers must only invoke this when auth is enabled.
 */
function readSigningKeysFile(workdir: string, signingKeysPath: string): ReadonlyArray<Jwk> {
  const absolutePath = resolveSigningKeysPath(workdir, signingKeysPath);

  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new ConfigValidateError(signingKeysReadErrorMessage(cause));
  }

  try {
    // `Jwk.key_ops` is mutable (required for Node's `createPrivateKey`/`JsonWebKey` input), so
    // it's copied into a fresh array rather than widening the schema's readonly output type.
    return decodeJwks(JSON.parse(contents)).map((jwk) => ({
      ...jwk,
      key_ops: jwk.key_ops === undefined ? undefined : [...jwk.key_ops],
    }));
  } catch (cause) {
    throw new ConfigValidateError(signingKeysDecodeErrorMessage(cause));
  }
}

/**
 * Returns the parsed signing keys only when auth is enabled and a path is configured;
 * `undefined` otherwise, so callers fall back to their own default key shape. Shared by
 * {@link resolveLocalJwks} and `start.handler.ts`'s `GOTRUE_JWT_KEYS` so both resolvers agree
 * on which key(s) apply.
 */
export function resolveConfiguredSigningKeys(
  config: CliConfig,
  workdir: string,
): ReadonlyArray<Jwk> | undefined {
  const signingKeysPath = config.auth.signing_keys_path;
  return config.auth.enabled && signingKeysPath !== undefined && signingKeysPath.length > 0
    ? readSigningKeysFile(workdir, signingKeysPath)
    : undefined;
}

/**
 * Confirms `api.tls.cert`/`.key` are readable when both are configured; the "exactly one set"
 * check lives in `validateResolvedConfig`. Unlike {@link readSigningKeysFile}'s
 * `signing_keys_path`, both paths join with the `supabase/` dir without an absolute-path guard.
 */
function readApiTlsFiles(
  workdir: string,
  certPath: string | undefined,
  keyPath: string | undefined,
): void {
  if (certPath === undefined || certPath.length === 0) return;
  if (keyPath === undefined || keyPath.length === 0) return;

  try {
    readFileSync(resolveApiTlsPath(workdir, certPath), "utf8");
  } catch (cause) {
    throw new ConfigValidateError(apiTlsCertReadErrorMessage(cause));
  }
  try {
    readFileSync(resolveApiTlsPath(workdir, keyPath), "utf8");
  } catch (cause) {
    throw new ConfigValidateError(apiTlsKeyReadErrorMessage(cause));
  }
}

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

/**
 * Reads each template/notification's content file, run only when auth is enabled. Every
 * template is checked unconditionally; a notification only when it's itself enabled. The
 * `content`-vs-`content_path` exclusivity and path resolution live in
 * `resolveEmailTemplateContentPath`; this only performs the read once a path comes back.
 */
function readAuthEmailTemplateContent(email: ResolvedAuthEmail, workdir: string): void {
  for (const [name, tmpl] of Object.entries(email.template)) {
    const path = resolveEmailTemplateContentPath({
      section: "template",
      name,
      contentPath: tmpl.content_path,
      contentPresent: tmpl.content_present,
      base: workdir,
    });
    if (path === undefined) continue;
    try {
      readFileSync(path, "utf8");
    } catch (cause) {
      throw new ConfigValidateError(emailContentPathReadErrorMessage("template", name, cause));
    }
  }
  for (const [name, tmpl] of Object.entries(email.notification)) {
    if (!tmpl.enabled) continue;
    const path = resolveEmailTemplateContentPath({
      section: "notification",
      name,
      contentPath: tmpl.content_path,
      contentPresent: tmpl.content_present,
      base: workdir,
    });
    if (path === undefined) continue;
    try {
      readFileSync(path, "utf8");
    } catch (cause) {
      throw new ConfigValidateError(emailContentPathReadErrorMessage("notification", name, cause));
    }
  }
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

/** Hook-type iteration order for {@link resolveAuthHooks}'s output. */
const HOOK_TYPE_ORDER = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
] as const;

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

/** A raw or `env(...)`-resolved `rp_origins` string is comma-split, not dropped. */
function rawOrigins(raw: unknown): Array<string> | undefined {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return typeof raw === "string" ? strToArr(raw) : undefined;
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

/**
 * Validates only the first enabled provider in the fixed priority order; a later
 * enabled-but-incomplete provider is never checked.
 */
function validateAuthSmsProviders(sms: CliConfig["auth"]["sms"]): void {
  function requireField(provider: string, field: string, value: string | undefined): void {
    if (value === undefined || value.length === 0) {
      throw new ConfigValidateError(
        `Missing required field in config: auth.sms.${provider}.${field}`,
      );
    }
  }

  if (sms.twilio.enabled) {
    requireField("twilio", "account_sid", sms.twilio.account_sid);
    requireField("twilio", "message_service_sid", sms.twilio.message_service_sid);
    requireField("twilio", "auth_token", sms.twilio.auth_token);
    return;
  }
  if (sms.twilio_verify.enabled) {
    requireField("twilio_verify", "account_sid", sms.twilio_verify.account_sid);
    requireField("twilio_verify", "message_service_sid", sms.twilio_verify.message_service_sid);
    requireField("twilio_verify", "auth_token", sms.twilio_verify.auth_token);
    return;
  }
  if (sms.messagebird.enabled) {
    requireField("messagebird", "originator", sms.messagebird.originator);
    requireField("messagebird", "access_key", sms.messagebird.access_key);
    return;
  }
  if (sms.textlocal.enabled) {
    requireField("textlocal", "sender", sms.textlocal.sender);
    requireField("textlocal", "api_key", sms.textlocal.api_key);
    return;
  }
  if (sms.vonage.enabled) {
    requireField("vonage", "from", sms.vonage.from);
    requireField("vonage", "api_key", sms.vonage.api_key);
    requireField("vonage", "api_secret", sms.vonage.api_secret);
    return;
  }
}

/** Deleted external providers, warned on if still enabled, never validated. */
const DEPRECATED_EXTERNAL_PROVIDERS = new Set(["linkedin", "slack"]);

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

/**
 * Weakly coerces an unmodeled document value (no `@supabase/config` schema, e.g. custom
 * `auth.external` providers, `auth.passkey`/`auth.webauthn`) to a bool, since an `env(VAR)`
 * substitution there skips normal type coercion and leaves a literal `"true"`/`"false"`
 * string. A number coerces via truthiness (`!= 0`); an unparsable string or any other type
 * throws rather than silently defaulting to `false`.
 */
export function rawUnmodeledBool(value: unknown, dottedFieldPath: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const raw = typeof value === "string" ? value : String(value);
  const parsed = typeof value === "string" ? parseBoolLiteral(value) : undefined;
  if (parsed === undefined) {
    throw new CliConfigValueError({
      path: dottedFieldPath,
      tier: "config",
      message: `Invalid config for ${dottedFieldPath}: "${raw}" is not a valid boolean`,
    });
  }
  return parsed;
}

/** Comma-splits a string, with the empty string as `[]`. */
function strToArr(value: string): Array<string> {
  return value.length === 0 ? [] : value.split(",");
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

  const result: Record<string, ResolvedAuthExternalProvider> = {};
  const decodedProviders = new Map(Object.entries(external));
  const providerNames = new Set([...Object.keys(externalDoc ?? {}), "apple"]);
  for (const name of providerNames) {
    if (DEPRECATED_EXTERNAL_PROVIDERS.has(name)) continue;
    const provider = decodedProviders.get(name);
    const rawProvider = provider === undefined ? asRecord(externalDoc?.[name]) : undefined;
    if (provider === undefined && rawProvider === undefined) continue;
    result[name] = {
      enabled:
        provider?.enabled ??
        rawUnmodeledBool(rawProvider?.["enabled"], `auth.external.${name}.enabled`),
      clientId: provider?.client_id ?? asString(rawProvider?.["client_id"]) ?? "",
      secret: provider?.secret ?? asString(rawProvider?.["secret"]),
      url: provider?.url ?? asString(rawProvider?.["url"]) ?? "",
      redirectUri: provider?.redirect_uri ?? asString(rawProvider?.["redirect_uri"]),
      skipNonceCheck:
        provider?.skip_nonce_check ??
        rawUnmodeledBool(
          rawProvider?.["skip_nonce_check"],
          `auth.external.${name}.skip_nonce_check`,
        ),
      emailOptional:
        provider?.email_optional ??
        rawUnmodeledBool(rawProvider?.["email_optional"], `auth.external.${name}.email_optional`),
    };
  }
  return result;
}

/**
 * Validates required fields for every enabled `auth.external.<name>` provider, including
 * custom names `@supabase/config`'s schema silently drops at decode time.
 */
function validateAuthExternalProviders(
  authDocument: Record<string, unknown> | undefined,
  external: CliConfig["auth"]["external"],
): void {
  const resolved = resolveAuthExternalProviders(authDocument, external);
  for (const [name, provider] of Object.entries(resolved)) {
    if (!provider.enabled) continue;
    if (provider.clientId.length === 0) {
      throw new ConfigValidateError(
        `Missing required field in config: auth.external.${name}.client_id`,
      );
    }
    if (
      name !== "apple" &&
      name !== "google" &&
      (provider.secret === undefined || provider.secret.length === 0)
    ) {
      throw new ConfigValidateError(
        `Missing required field in config: auth.external.${name}.secret`,
      );
    }
  }
}

/**
 * @throws when `project_id` is an explicit empty string. Checked first: the sanitized workdir
 * basename is the default, so a workdir whose basename sanitizes to `""` fails even with no
 * `project_id` key at all.
 * @throws {InvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws when a configured `api.tls` cert/key file can't be read — see
 * {@link readApiTlsFiles}.
 * @throws when `auth.signing_keys_path` is set, auth is enabled, and the file is missing,
 * malformed, or its first key uses an unsupported algorithm — see
 * {@link resolveConfiguredSigningKeys} and {@link generateAsymmetricLocalJwt}.
 * @throws when an email template's `content` is present without `content_path`, or a
 * configured `content_path` file can't be read — see {@link readAuthEmailTemplateContent}.
 * @throws {ConfigValidateError} for every other validation branch, deferred to a single call
 * to {@link validateResolvedConfig} at the end of this function.
 */
export function resolveLocalConfigValues(
  config: CliConfig,
  hostname: string,
  workdir: string,
  /**
   * The effective document `config` was decoded from, for checks that hinge on section presence
   * (not the always-defaulted decoded value). `undefined` callers skip those checks.
   */
  document?: Readonly<Record<string, unknown>>,
): LocalConfigValues {
  const resolvedProjectId = config.project_id ?? "";

  const apiTlsEnabled = config.api.tls.enabled;
  const apiEnabled = config.api.enabled;
  const apiTlsCertPath = config.api.tls.cert_path;
  const apiTlsKeyPath = config.api.tls.key_path;
  if (apiEnabled && apiTlsEnabled) {
    readApiTlsFiles(workdir, apiTlsCertPath, apiTlsKeyPath);
  }
  const apiPort = config.api.port;
  const apiExternalUrl = resolveApiExternalUrl(
    {
      external_url: config.api.external_url,
      port: apiPort,
      tls: { enabled: apiTlsEnabled },
    },
    hostname,
  );
  const dbPort = config.db.port;
  const majorVersion = config.db.major_version;
  // `db.root_key` isn't modeled in `@supabase/config`'s schema, so it's read off the document.
  // The resolved value is written verbatim into `/etc/postgresql-custom/pgsodium_root.key`.
  const rawRootKey = asRecord(document?.["db"])?.["root_key"];
  if (rawRootKey !== undefined && typeof rawRootKey !== "string") {
    throw new ConfigValidateError("failed to parse config:\ndb.root_key: expected a table");
  }
  const rootKey =
    rawRootKey === undefined || rawRootKey.length === 0 ? POSTGRES_DEFAULT_ROOT_KEY : rawRootKey;
  const storageBucketNames =
    config.storage.buckets !== undefined ? Object.keys(config.storage.buckets) : [];
  const studioEnabled = config.studio.enabled;
  const studioPort = config.studio.port;
  const studioApiUrl = config.studio.api_url;
  const mailpitEnabled = config.local_smtp.enabled;
  const mailpitPort = config.local_smtp.port;
  const jwtSecret = resolveJwtSecret(config.auth.jwt_secret);
  const signingKeysPath = config.auth.signing_keys_path;
  // The signing-keys file read only runs when auth is enabled, so a disabled auth section
  // never opens/parses `signing_keys_path`, even a stale or missing one. JWT-secret validation
  // and anon/service_role key generation run unconditionally either way.
  const authEnabled = config.auth.enabled;
  const siteUrl = config.auth.site_url;
  const authDocument = asRecord(document?.["auth"]);
  const captchaInput = resolveAuthCaptcha(config.auth.captcha);
  // A disabled-auth config with a configured path must still sign asymmetrically with the
  // default key, not fall back to symmetric HS256.
  const signingKey =
    signingKeysPath !== undefined && signingKeysPath.length > 0
      ? (resolveConfiguredSigningKeys(config, workdir) ?? [DEFAULT_SIGNING_KEY])[0]
      : undefined;
  // This block only accumulates the inputs passkey/webauthn/hook/mfa/email/smtp/third_party
  // validation needs; the checks themselves run once, later, in the single
  // `validateResolvedConfig` call below (sms/external run separately after it).
  let authInput: AuthInput | undefined;
  if (authEnabled) {
    const passkeyDoc = asRecord(authDocument?.["passkey"]);
    const webauthnDoc = asRecord(authDocument?.["webauthn"]);
    const passkeyEnabled =
      passkeyDoc !== undefined && rawUnmodeledBool(passkeyDoc["enabled"], "auth.passkey.enabled");
    const rpId = asString(webauthnDoc?.["rp_id"]);
    const rpOrigins = rawOrigins(webauthnDoc?.["rp_origins"]);
    const passkey: PasskeyInput | undefined = passkeyEnabled
      ? { webauthnPresent: webauthnDoc !== undefined, rpId, rpOrigins }
      : undefined;

    const resolvedHooks = resolveAuthHooks(config.auth.hook);
    const hooks: Array<HookInput> = HOOK_TYPE_ORDER.filter(
      (hookType) => resolvedHooks[HOOK_TYPE_TO_CAMEL[hookType]].enabled,
    ).map((hookType) => {
      const resolved = resolvedHooks[HOOK_TYPE_TO_CAMEL[hookType]];
      return { type: hookType, uri: resolved.uri, secrets: resolved.secrets };
    });

    const resolvedMfa = config.auth.mfa;
    const mfa: ReadonlyArray<MfaFactorInput> = [
      {
        label: "totp",
        enrollEnabled: resolvedMfa.totp.enroll_enabled,
        verifyEnabled: resolvedMfa.totp.verify_enabled,
      },
      {
        label: "phone",
        enrollEnabled: resolvedMfa.phone.enroll_enabled,
        verifyEnabled: resolvedMfa.phone.verify_enabled,
      },
      {
        label: "web_authn",
        enrollEnabled: resolvedMfa.web_authn.enroll_enabled,
        verifyEnabled: resolvedMfa.web_authn.verify_enabled,
      },
    ];

    readAuthEmailTemplateContent(resolveAuthEmail(config.auth.email, authDocument), workdir);

    const resolvedSmtp = resolveAuthEmailSmtp(authDocument);
    const smtp: SmtpInput | undefined =
      resolvedSmtp === undefined
        ? undefined
        : {
            enabled: resolvedSmtp.enabled,
            host: resolvedSmtp.host,
            port: resolvedSmtp.port,
            user: resolvedSmtp.user,
            pass: resolvedSmtp.pass,
            adminEmail: resolvedSmtp.adminEmail,
          };

    authInput = {
      siteUrl: siteUrl ?? "",
      captcha: captchaInput,
      passkey,
      hooks,
      mfa,
      smtp,
      thirdParty: resolveThirdPartyProviders(config.auth.third_party),
    };
  }
  const functionSlugs = Object.keys(config.functions);
  const denoVersion = config.edge_runtime.deno_version;

  const analyticsEnabled = config.analytics.enabled;
  const analyticsBackend = narrowConfigEnum("analytics.backend", config.analytics.backend, [
    "postgres",
    "bigquery",
  ]);
  const gcpProjectId = config.analytics.gcp_project_id;
  const gcpProjectNumber = config.analytics.gcp_project_number;
  const gcpJwtPath = config.analytics.gcp_jwt_path;

  // The webhooks check isn't "the user disabled a feature": an omitted `enabled` key in a
  // present `[experimental.webhooks]` section is rejected too — the section exists only so it
  // can be turned on, never explicitly off. This hinges on section presence, which the
  // schema's decode-time default erases (`experimental.webhooks` always decodes to
  // `{ enabled: false }` even when absent), so this reads the document instead.
  const experimentalDocument = asRecord(document?.["experimental"]);
  const webhooksPresent = asRecord(experimentalDocument?.["webhooks"]) !== undefined;
  const webhooksEnabled = config.experimental.webhooks?.enabled === true;
  const pgdeltaFormatOptions = config.experimental.pgdelta?.format_options ?? "";

  // Every pure validation check runs in one place, here, rather than interleaved with this
  // function's 3 I/O reads (signing keys, api.tls cert/key, email content).
  const apiInput: ApiInput = {
    enabled: apiEnabled,
    port: apiPort,
    tls: { enabled: apiTlsEnabled, certPath: apiTlsCertPath, keyPath: apiTlsKeyPath },
  };
  const dbInput: DbInput = { port: dbPort, majorVersion };
  const studioInput: StudioInput = {
    enabled: studioEnabled,
    port: studioPort,
    apiUrl: studioApiUrl,
  };
  const localSmtpInput: LocalSmtpInput = { enabled: mailpitEnabled, port: mailpitPort };
  const analyticsInput: AnalyticsInput = {
    enabled: analyticsEnabled,
    backend: analyticsBackend,
    gcpProjectId: gcpProjectId ?? "",
    gcpProjectNumber: gcpProjectNumber ?? "",
    gcpJwtPath: gcpJwtPath ?? "",
  };
  const experimentalInput: ExperimentalInput = {
    webhooksPresent,
    webhooksEnabled,
    pgdeltaFormatOptions,
  };

  const input: ConfigValidationInput = {
    projectId: resolvedProjectId,
    api: apiInput,
    db: dbInput,
    storageBucketNames,
    studio: studioInput,
    localSmtp: localSmtpInput,
    auth: authInput,
    functionSlugs,
    edgeRuntimeDenoVersion: denoVersion,
    analytics: analyticsInput,
    experimental: experimentalInput,
  };
  validateResolvedConfig(input);
  if (authEnabled) {
    validateAuthSmsProviders(resolveAuthSms(config.auth.sms));
    validateAuthExternalProviders(authDocument, config.auth.external);
  }

  return {
    apiUrl: apiExternalUrl,
    apiPort,
    dbPort,
    studioPort,
    rootKey,
    openaiApiKey: config.studio.openai_api_key,
    authSiteUrl: siteUrl,
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
    anonKey: resolveSignedKey(config.auth.anon_key, jwtSecret, signingKey, "anon"),
    serviceRoleKey: resolveSignedKey(
      config.auth.service_role_key,
      jwtSecret,
      signingKey,
      "service_role",
    ),
    storageS3Url: apiUrlWithPath(apiExternalUrl, "/storage/v1/s3"),
    storageS3AccessKeyId: DEFAULT_S3_ACCESS_KEY_ID,
    storageS3SecretAccessKey: DEFAULT_S3_SECRET_ACCESS_KEY,
    storageS3Region: DEFAULT_S3_REGION,
    analyticsEnabled,
    analyticsBackend,
    gcpProjectId: gcpProjectId ?? "",
    gcpProjectNumber: gcpProjectNumber ?? "",
    gcpJwtPath: gcpJwtPath ?? "",
    // Sanitized here, not in `input.projectId` above: `validateResolvedConfig`'s check is
    // presence-only and must see the raw value to reject an explicit `project_id = ""`.
    projectId: sanitizeProjectId(resolvedProjectId),
    edgeRuntimeDenoVersion: denoVersion,
  };
}

/** Resolves local and remote signing keys for services that consume the local JWKS document. */
export const resolveLocalJwks = Effect.fnUntraced(function* (
  config: CliConfig,
  workdir: string,
  jwtSecret: string,
) {
  const { issuerUrl, signingKeys, signingKeysPath } = yield* Effect.try({
    try: () => {
      const signingKeysPath = config.auth.signing_keys_path;
      // Every resolved config carries the default ES256 key, regardless of `auth.enabled`. It's
      // only ever replaced by a configured `signing_keys_path` file, and only when that file is
      // actually read (gated on `auth.enabled` — see {@link resolveConfiguredSigningKeys}). So JWKS
      // resolution always publishes either the file's keys or this default, never neither —
      // `GOTRUE_JWT_KEYS` signs with the same default, so the two must never disagree.
      const signingKeys: ReadonlyArray<Jwk> = resolveConfiguredSigningKeys(config, workdir) ?? [
        DEFAULT_SIGNING_KEY,
      ];

      // `resolveThirdPartyIssuerUrl`'s "at most one enabled" + required-field checks are only
      // meaningful while auth is enabled; when auth is disabled they are skipped, so the
      // unchecked, no-throw issuer-url builder applies instead.
      const thirdParty = config.auth.third_party;
      const issuerUrl = Option.fromNullishOr(
        config.auth.enabled
          ? resolveThirdPartyIssuerUrl(thirdParty)
          : thirdPartyIssuerUrlUnchecked(thirdParty),
      ).pipe(Option.filter((value) => value.length > 0));
      return { issuerUrl, signingKeys, signingKeysPath };
    },
    catch: (cause) =>
      cause instanceof ConfigValidateError
        ? cause
        : new ConfigValidateError(cause instanceof Error ? cause.message : String(cause)),
  });
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
    keys.push({ kty: "oct", k: Encoding.encodeBase64Url(jwtSecret) });
  }
  return yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(Schema.Unknown) })),
  )({ keys }).pipe(Effect.mapError((cause) => new ConfigValidateError(cause.message)));
});

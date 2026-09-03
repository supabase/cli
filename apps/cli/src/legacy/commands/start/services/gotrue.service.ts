/**
 * GoTrue/Auth env + container spec builder, gated on `config.auth.enabled`
 * and `!isContainerExcluded(config.auth.image, excluded)` — see
 * `legacy-service-catalog.ts`'s `gotrue` entry (`excludeKey: "gotrue"`, gated
 * on `auth.enabled`). Gating and image resolution/pre-pull are the caller's
 * job (a future `start.handler.ts`); this module only assembles the
 * env/container spec once the caller has already decided to start it.
 *
 * {@link legacyBuildGotrueEnv} deliberately reproduces the FULL env surface
 * GoTrue's container actually receives, including every conditional env var
 * on top of the base set: JWT signing keys, SMTP/Mailpit fallback, mailer
 * template/notification URLs, the fixed-priority SMS provider switch,
 * CAPTCHA, the six auth hooks, MFA phone extras, passkey/WebAuthn, external
 * OAuth providers, Web3, OAuth server. See `gotrue.service.unit.test.ts` for
 * coverage.
 *
 * `@supabase/config` schema gaps this module works around (all pre-existing,
 * not introduced here — see each input field's own doc comment):
 *   - `auth.external_url` has no schema field at all, so the caller reads it
 *     off the raw TOML document (same pattern as the gaps below) and passes
 *     the resolved value in as {@link LegacyBuildGotrueEnvInput.authExternalUrl}
 *     — when set, it wins over the `apiUrl`-derived fallback for
 *     `API_EXTERNAL_URL`/`GOTRUE_JWT_ISSUER`'s default/the mailer verify URL/
 *     OAuth redirect-URI fallbacks. `config push`'s auth update body has no
 *     such gap to share: it has no `external_url`/`jwt_issuer` field at all,
 *     so there's nothing for that command to derive or resolve.
 *   - `auth.captcha`/`auth.passkey`/`auth.webauthn`/`auth.email.smtp`'s
 *     presence-and-default quirks (an explicitly-omitted `enabled` is
 *     treated differently depending on whether the surrounding TOML table is
 *     present at all) can't be recovered from the decoded `CliConfig`
 *     alone — the caller resolves these the same way
 *     `legacy-local-config-values.ts` already does (reading the raw TOML
 *     document) and passes the final, presence-resolved values in.
 *   - `auth.external` decodes as a FIXED struct of ~19 known providers, each
 *     always present with `enabled: false` when unconfigured — but the real
 *     provider set is whatever a user's `config.toml` actually mentions, and
 *     `legacyAppendGotrueExternalProviderEnv` iterates that real map
 *     unconditionally (emitting `_ENABLED=false` etc. for a
 *     configured-but-disabled provider, never for an unconfigured one).
 *     {@link LegacyBuildGotrueEnvInput.externalProviders} must therefore
 *     already be presence-filtered by the caller (only the providers whose
 *     `[auth.external.<name>]` section actually exists in the TOML
 *     document), the same way `legacy-local-config-values.ts`'s
 *     `validateAuthExternalProviders` already filters for its own purposes.
 */

import type { CliConfig } from "@supabase/config";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import {
  legacyFormatGoDuration,
  legacyParseGoDuration,
} from "../../../shared/legacy-go-duration.ts";
import { LEGACY_DEFAULT_SIGNING_KEY } from "../../../shared/legacy-go-jwt.ts";
import type { LegacyResolvedAuthEmail } from "../../../shared/legacy-local-config-values.ts";
import { legacyPasswordRequirementsToChar } from "../../../shared/legacy-password-requirements.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import {
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "../../../shared/db-bootstrap/internal-db-connection.ts";
import {
  legacySlimWgetHealthcheck,
  legacyUsesSlimRuntime,
} from "../../../shared/db-bootstrap/slim-runtime.ts";

/** The GoTrue network alias — also this service's `containerSuffix` in `LEGACY_SERVICE_CATALOG`. */
const LEGACY_GOTRUE_CONTAINER_SUFFIX = "auth";

/** GoTrue's fixed listen port — never published to the host. */
const LEGACY_GOTRUE_PORT = "9999";

/** Kong's nginx template server port, used for mailer template/subject URLs. */
const LEGACY_GOTRUE_NGINX_TEMPLATE_SERVER_PORT = 8088;

/** The default Inbucket admin email/sender name. */
const LEGACY_GOTRUE_DEFAULT_INBUCKET_ADMIN_EMAIL = "admin@email.com";
const LEGACY_GOTRUE_DEFAULT_INBUCKET_SENDER_NAME = "Admin";

/** `supabase_auth_admin` — the fixed Postgres role GoTrue's `GOTRUE_DB_DATABASE_URL` authenticates as. */
const LEGACY_GOTRUE_DB_ROLE = "supabase_auth_admin";

/**
 * RFC 7517 JWK fields, in the exact field declaration order — needed so
 * {@link legacyBuildGotrueEnv}'s `JSON.stringify` reproduces a stable,
 * canonical serialization byte-for-byte (`JSON.stringify` serializes object
 * keys in insertion order).
 * Structurally near-identical to `legacy/shared/legacy-go-jwt.ts`'s `LegacyJwk`
 * (the only difference is `key_ops`'s mutable `string[]` there, needed for
 * assignability into Node's `createPrivateKey`/`JsonWebKey` input — see that
 * type's own doc comment) and a superset of `shared/auth/jwks.ts`'s `JwkLike`
 * (which omits the private-key fields `d`/`p`/`q`/`dp`/`dq`/`qi`) — kept local
 * rather than reusing either shared type, since neither of their existing
 * callers needs the union of all seventeen fields.
 */
export interface LegacyGotrueSigningKey {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly key_ops?: ReadonlyArray<string>;
  readonly alg?: string;
  readonly ext?: boolean;
  readonly n?: string;
  readonly e?: string;
  readonly d?: string;
  readonly p?: string;
  readonly q?: string;
  readonly dp?: string;
  readonly dq?: string;
  readonly qi?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

/**
 * The default single signing key — used whenever `auth.signing_keys_path`
 * is unset. Hoisted to `legacy-go-jwt.ts` (as `LEGACY_DEFAULT_SIGNING_KEY`)
 * so `legacyResolveLocalJwks` publishes the exact same key's public form in
 * the JWKS this default signs with — the two must never disagree on which
 * key is "the" default.
 */
const LEGACY_GOTRUE_DEFAULT_SIGNING_KEY: LegacyGotrueSigningKey = LEGACY_DEFAULT_SIGNING_KEY;

/**
 * The `auth.sms.test_otp` map's `GOTRUE_SMS_TEST_OTP` wire format:
 * `key:value` pairs, comma-joined, no trailing comma. Iterates
 * `Object.entries` (insertion order); order is not part of the contract
 * here, only the `key:value,...` shape.
 */
export function legacyFormatMapForEnvConfig(input: Readonly<Record<string, string>>): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
}

/** One already-resolved, presence-gated `[auth.hook.<type>]` entry — see this module's header for why presence must be pre-resolved by the caller. */
export interface LegacyGotrueHookInput {
  readonly enabled: boolean;
  readonly uri?: string;
  readonly secrets?: string;
}

/** `[auth.webauthn]`, present iff the caller's raw TOML document has that section. */
export interface LegacyGotrueWebauthnInput {
  readonly rpId: string;
  readonly rpDisplayName: string;
  readonly rpOrigins: ReadonlyArray<string>;
}

/**
 * One already-presence-filtered `[auth.external.<name>]` entry — see this
 * module's header for why the caller must filter the whole map by TOML
 * presence before calling {@link legacyBuildGotrueEnv}.
 */
export interface LegacyGotrueExternalProviderInput {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly secret?: string;
  readonly url: string;
  readonly redirectUri?: string;
  readonly skipNonceCheck: boolean;
  readonly emailOptional: boolean;
}

export interface LegacyBuildGotrueEnvInput {
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** `config.db.password` — see {@link legacyStartInternalDbPassword}. */
  readonly dbPassword: string;

  /**
   * `LegacyLocalConfigValues.apiUrl` — reused, not recomputed, so
   * `API_EXTERNAL_URL`/`GOTRUE_JWT_ISSUER`'s derived fallback (used when
   * {@link authExternalUrl} is unset) never drifts from what `status`
   * reports.
   */
  readonly apiUrl: string;
  /**
   * Raw `auth.external_url` (already `SUPABASE_AUTH_EXTERNAL_URL`-overridden
   * by the caller): an explicit value wins outright, otherwise it's derived
   * as `TrimRight(apiUrl, "/") + "/auth/v1"`. `undefined`/empty means unset
   * — fall back to the `apiUrl` derivation.
   */
  readonly authExternalUrl?: string;
  /** `LegacyLocalConfigValues.jwtSecret` — reused, not recomputed. */
  readonly jwtSecret: string;
  /** `config.auth.jwt_issuer`, raw (`undefined` when unset — falls back to the derived auth-external URL). */
  readonly jwtIssuer: string | undefined;
  readonly jwtExpiry: CliConfig["auth"]["jwt_expiry"];
  readonly siteUrl: CliConfig["auth"]["site_url"];
  readonly additionalRedirectUrls: CliConfig["auth"]["additional_redirect_urls"];
  readonly enableSignup: CliConfig["auth"]["enable_signup"];
  readonly enableAnonymousSignIns: CliConfig["auth"]["enable_anonymous_sign_ins"];
  readonly enableRefreshTokenRotation: CliConfig["auth"]["enable_refresh_token_rotation"];
  readonly refreshTokenReuseInterval: CliConfig["auth"]["refresh_token_reuse_interval"];
  readonly enableManualLinking: CliConfig["auth"]["enable_manual_linking"];
  readonly minimumPasswordLength: CliConfig["auth"]["minimum_password_length"];
  readonly passwordRequirements: CliConfig["auth"]["password_requirements"];

  /**
   * `config.auth.signing_keys_path`'s resolved contents (the file's
   * contents via `legacy-local-config-values.ts`'s `loadSigningKeys`, when
   * configured). Defaults to the hardcoded single ES256 key
   * ({@link LEGACY_GOTRUE_DEFAULT_SIGNING_KEY}) when omitted.
   */
  readonly signingKeys?: ReadonlyArray<LegacyGotrueSigningKey>;

  /** `config.auth.email`, everything except `smtp` (kept separate — see {@link smtp}). */
  readonly email: Omit<LegacyResolvedAuthEmail, "smtp">;
  /** Kong's own container name — mailer template/subject URLs route through it. */
  readonly kongContainerName: string;

  /**
   * `config.auth.email.smtp`, already presence-and-default resolved by the
   * caller (`@supabase/config` can't reproduce the "TOML table present,
   * `enabled` key absent → true" default on its own, see this module's
   * header). `undefined` means the SMTP section is absent or disabled — the
   * mailpit fallback below applies instead.
   */
  readonly smtp?: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly pass: string;
    readonly adminEmail: string;
    readonly senderName?: string;
  };
  /**
   * `config.local_smtp`, present iff `local_smtp.enabled` AND {@link smtp}
   * is unset. `adminEmail`/`senderName` default to the literals below when
   * unset, since `@supabase/config`'s `inbucket.ts` schema has no default
   * for either.
   */
  readonly mailpit?: {
    readonly containerName: string;
    readonly adminEmail?: string;
    readonly senderName?: string;
  };

  readonly sms: CliConfig["auth"]["sms"];
  readonly sessions: CliConfig["auth"]["sessions"];
  readonly mfa: CliConfig["auth"]["mfa"];
  readonly rateLimit: CliConfig["auth"]["rate_limit"];
  readonly web3: CliConfig["auth"]["web3"];
  readonly oauthServer: CliConfig["auth"]["oauth_server"];
  /**
   * `config.auth.hook.<type>`, each already presence-resolved AND
   * env-override-resolved by the caller (`legacyResolveAuthHooks` —
   * `SUPABASE_AUTH_HOOK_<TYPE>_ENABLED`/`_URI`/`_SECRETS`).
   */
  readonly hooks: {
    readonly mfaVerificationAttempt: LegacyGotrueHookInput;
    readonly passwordVerificationAttempt: LegacyGotrueHookInput;
    readonly customAccessToken: LegacyGotrueHookInput;
    readonly sendSms: LegacyGotrueHookInput;
    readonly sendEmail: LegacyGotrueHookInput;
    readonly beforeUserCreated: LegacyGotrueHookInput;
  };

  /**
   * `config.auth.captcha`, already presence-resolved AND env-override-resolved
   * by the caller (`legacyResolveAuthCaptcha` — `SUPABASE_AUTH_CAPTCHA_ENABLED`/
   * `_PROVIDER`/`_SECRET`, `secret` decrypted like every other `Secret`-typed
   * field). `@supabase/config`'s `withDecodingDefaultKey` fills in `{enabled:
   * false}` even when `[auth.captcha]` is absent — see this module's header.
   * `undefined` means the section itself is absent.
   */
  readonly captcha?: {
    readonly enabled: boolean;
    readonly provider?: string;
    readonly secret?: string;
  };

  /** `[auth.passkey].enabled`, `undefined` iff the section is absent — see this module's header (not in `@supabase/config`'s schema at all). */
  readonly passkeyEnabled?: boolean;
  /** `[auth.webauthn]`, `undefined` iff the section is absent — independent of {@link passkeyEnabled} (each section's presence is checked separately). */
  readonly webauthn?: LegacyGotrueWebauthnInput;

  /** Already presence-filtered by the caller — see this module's header. */
  readonly externalProviders: Readonly<Record<string, LegacyGotrueExternalProviderInput>>;
}

function legacyTrimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Two INDEPENDENT presence gates for passkey/WebAuthn env vars — config
 * validation requires `Auth.Webauthn` whenever `Auth.Passkey.Enabled`, but
 * this function doesn't assume that invariant.
 */
function legacyAppendGotruePasskeyEnv(
  env: Record<string, string>,
  passkeyEnabled: boolean | undefined,
  webauthn: LegacyGotrueWebauthnInput | undefined,
): void {
  if (passkeyEnabled !== undefined) {
    env["GOTRUE_PASSKEY_ENABLED"] = String(passkeyEnabled);
  }
  if (webauthn !== undefined) {
    env["GOTRUE_WEBAUTHN_RP_ID"] = webauthn.rpId;
    env["GOTRUE_WEBAUTHN_RP_DISPLAY_NAME"] = webauthn.rpDisplayName;
    env["GOTRUE_WEBAUTHN_RP_ORIGINS"] = webauthn.rpOrigins.join(",");
  }
}

/**
 * Iterates `providers` unconditionally (every entry, enabled or not) — there
 * is no `enabled` gate at all, only the trailing `URL` field is conditional.
 * See this module's header for why `providers` must already be
 * presence-filtered by the caller.
 */
function legacyAppendGotrueExternalProviderEnv(
  env: Record<string, string>,
  providers: Readonly<Record<string, LegacyGotrueExternalProviderInput>>,
  jwtIssuer: string,
): void {
  for (const [name, provider] of Object.entries(providers)) {
    const upper = name.toUpperCase();
    const redirectUri =
      provider.redirectUri !== undefined && provider.redirectUri.length > 0
        ? provider.redirectUri
        : `${jwtIssuer}/callback`;
    env[`GOTRUE_EXTERNAL_${upper}_ENABLED`] = String(provider.enabled);
    env[`GOTRUE_EXTERNAL_${upper}_CLIENT_ID`] = provider.clientId;
    env[`GOTRUE_EXTERNAL_${upper}_SECRET`] = provider.secret ?? "";
    env[`GOTRUE_EXTERNAL_${upper}_SKIP_NONCE_CHECK`] = String(provider.skipNonceCheck);
    env[`GOTRUE_EXTERNAL_${upper}_EMAIL_OPTIONAL`] = String(provider.emailOptional);
    env[`GOTRUE_EXTERNAL_${upper}_REDIRECT_URI`] = redirectUri;
    if (provider.url.length > 0) {
      env[`GOTRUE_EXTERNAL_${upper}_URL`] = provider.url;
    }
  }
}

/**
 * Builds a plain object with keys in the canonical JWK field declaration
 * order, omitting every empty field (an absent/`undefined` field, or an
 * empty string — `ext`/`key_ops` are only dropped when `undefined`, not for
 * any other falsy value). `JSON.stringify` then serializes in that same
 * insertion order, producing a stable, canonical byte representation.
 */
function legacyOrderGotrueSigningKey(key: LegacyGotrueSigningKey): Record<string, unknown> {
  const ordered: Record<string, unknown> = { kty: key.kty };
  if (key.kid !== undefined && key.kid.length > 0) ordered["kid"] = key.kid;
  if (key.use !== undefined && key.use.length > 0) ordered["use"] = key.use;
  if (key.key_ops !== undefined) ordered["key_ops"] = key.key_ops;
  if (key.alg !== undefined && key.alg.length > 0) ordered["alg"] = key.alg;
  if (key.ext !== undefined) ordered["ext"] = key.ext;
  if (key.n !== undefined && key.n.length > 0) ordered["n"] = key.n;
  if (key.e !== undefined && key.e.length > 0) ordered["e"] = key.e;
  if (key.d !== undefined && key.d.length > 0) ordered["d"] = key.d;
  if (key.p !== undefined && key.p.length > 0) ordered["p"] = key.p;
  if (key.q !== undefined && key.q.length > 0) ordered["q"] = key.q;
  if (key.dp !== undefined && key.dp.length > 0) ordered["dp"] = key.dp;
  if (key.dq !== undefined && key.dq.length > 0) ordered["dq"] = key.dq;
  if (key.qi !== undefined && key.qi.length > 0) ordered["qi"] = key.qi;
  if (key.crv !== undefined && key.crv.length > 0) ordered["crv"] = key.crv;
  if (key.x !== undefined && key.x.length > 0) ordered["x"] = key.x;
  if (key.y !== undefined && key.y.length > 0) ordered["y"] = key.y;
  return ordered;
}

/** The last `.`-prefixed suffix of the final path segment, or `""` if there is none. */
function legacyFileExt(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

/**
 * Pure GoTrue container env builder — assembles the FULL env surface
 * described in this module's header. See there for the full rationale and
 * the `@supabase/config` schema gaps this input type works around. No
 * Effect, no I/O — every field is a plain, already-resolved value.
 */
export function legacyBuildGotrueEnv(input: LegacyBuildGotrueEnvInput): Record<string, string> {
  const authExternalUrl =
    input.authExternalUrl !== undefined && input.authExternalUrl.length > 0
      ? input.authExternalUrl
      : `${legacyTrimTrailingSlashes(input.apiUrl)}/auth/v1`;
  const jwtIssuer =
    input.jwtIssuer !== undefined && input.jwtIssuer.length > 0 ? input.jwtIssuer : authExternalUrl;
  const mailerVerifyUrl = `${legacyTrimTrailingSlashes(authExternalUrl)}/verify`;
  const testOtp =
    input.sms.test_otp !== undefined ? legacyFormatMapForEnvConfig(input.sms.test_otp) : "";

  const env: Record<string, string> = {
    API_EXTERNAL_URL: authExternalUrl,

    GOTRUE_API_HOST: "0.0.0.0",
    GOTRUE_API_PORT: LEGACY_GOTRUE_PORT,

    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: legacyStartInternalDbUrl(
      LEGACY_GOTRUE_DB_ROLE,
      input.dbHost,
      input.dbPassword,
    ),

    GOTRUE_SITE_URL: input.siteUrl,
    GOTRUE_URI_ALLOW_LIST: input.additionalRedirectUrls.join(","),
    GOTRUE_DISABLE_SIGNUP: String(!input.enableSignup),

    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_EXP: String(input.jwtExpiry),
    GOTRUE_JWT_SECRET: input.jwtSecret,
    GOTRUE_JWT_ISSUER: jwtIssuer,

    GOTRUE_EXTERNAL_EMAIL_ENABLED: String(input.email.enable_signup),
    GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: String(input.email.double_confirm_changes),
    GOTRUE_MAILER_AUTOCONFIRM: String(!input.email.enable_confirmations),
    GOTRUE_MAILER_OTP_LENGTH: String(input.email.otp_length),
    GOTRUE_MAILER_OTP_EXP: String(input.email.otp_expiry),
    GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED: "true",

    GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: String(input.enableAnonymousSignIns),

    GOTRUE_SMTP_MAX_FREQUENCY: legacyFormatGoDuration(
      legacyParseGoDuration(input.email.max_frequency),
    ),

    GOTRUE_MAILER_URLPATHS_INVITE: mailerVerifyUrl,
    GOTRUE_MAILER_URLPATHS_CONFIRMATION: mailerVerifyUrl,
    GOTRUE_MAILER_URLPATHS_RECOVERY: mailerVerifyUrl,
    GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: mailerVerifyUrl,
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "360000",

    GOTRUE_EXTERNAL_PHONE_ENABLED: String(input.sms.enable_signup),
    GOTRUE_SMS_AUTOCONFIRM: String(!input.sms.enable_confirmations),
    GOTRUE_SMS_MAX_FREQUENCY: legacyFormatGoDuration(
      legacyParseGoDuration(input.sms.max_frequency),
    ),
    GOTRUE_SMS_OTP_EXP: "6000",
    GOTRUE_SMS_OTP_LENGTH: "6",
    GOTRUE_SMS_TEMPLATE: input.sms.template,
    GOTRUE_SMS_TEST_OTP: testOtp,

    GOTRUE_PASSWORD_MIN_LENGTH: String(input.minimumPasswordLength),
    GOTRUE_PASSWORD_REQUIRED_CHARACTERS: legacyPasswordRequirementsToChar(
      input.passwordRequirements,
    ),
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: String(input.enableRefreshTokenRotation),
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: String(input.refreshTokenReuseInterval),
    GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: String(input.enableManualLinking),
    GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: String(
      input.email.secure_password_change,
    ),
    GOTRUE_MFA_PHONE_ENROLL_ENABLED: String(input.mfa.phone.enroll_enabled),
    GOTRUE_MFA_PHONE_VERIFY_ENABLED: String(input.mfa.phone.verify_enabled),
    GOTRUE_MFA_TOTP_ENROLL_ENABLED: String(input.mfa.totp.enroll_enabled),
    GOTRUE_MFA_TOTP_VERIFY_ENABLED: String(input.mfa.totp.verify_enabled),
    GOTRUE_MFA_WEB_AUTHN_ENROLL_ENABLED: String(input.mfa.web_authn.enroll_enabled),
    GOTRUE_MFA_WEB_AUTHN_VERIFY_ENABLED: String(input.mfa.web_authn.verify_enabled),
    GOTRUE_MFA_MAX_ENROLLED_FACTORS: String(input.mfa.max_enrolled_factors),

    GOTRUE_RATE_LIMIT_ANONYMOUS_USERS: String(input.rateLimit.anonymous_users),
    GOTRUE_RATE_LIMIT_TOKEN_REFRESH: String(input.rateLimit.token_refresh),
    GOTRUE_RATE_LIMIT_OTP: String(input.rateLimit.sign_in_sign_ups),
    GOTRUE_RATE_LIMIT_VERIFY: String(input.rateLimit.token_verifications),
    GOTRUE_RATE_LIMIT_SMS_SENT: String(input.rateLimit.sms_sent),
    GOTRUE_RATE_LIMIT_WEB3: String(input.rateLimit.web3),
  };

  // JWT signing keys — `JSON.stringify` never fails for this shape.
  const signingKeys = input.signingKeys ?? [LEGACY_GOTRUE_DEFAULT_SIGNING_KEY];
  env["GOTRUE_JWT_KEYS"] = JSON.stringify(signingKeys.map(legacyOrderGotrueSigningKey));
  // TODO: deprecate HS256 when it's no longer supported.
  // TODO: remove VALIDMETHODS after a while to avoid breaking changes.
  env["GOTRUE_JWT_VALIDMETHODS"] = "HS256,RS256,ES256";
  env["GOTRUE_JWT_VALID_METHODS"] = "HS256,RS256,ES256";

  // SMTP, else Mailpit fallback.
  if (input.smtp !== undefined) {
    env["GOTRUE_RATE_LIMIT_EMAIL_SENT"] = String(input.rateLimit.email_sent);
    env["GOTRUE_SMTP_HOST"] = input.smtp.host;
    env["GOTRUE_SMTP_PORT"] = String(input.smtp.port);
    env["GOTRUE_SMTP_USER"] = input.smtp.user;
    env["GOTRUE_SMTP_PASS"] = input.smtp.pass;
    env["GOTRUE_SMTP_ADMIN_EMAIL"] = input.smtp.adminEmail;
    env["GOTRUE_SMTP_SENDER_NAME"] = input.smtp.senderName ?? "";
  } else if (input.mailpit !== undefined) {
    env["GOTRUE_SMTP_HOST"] = input.mailpit.containerName;
    env["GOTRUE_SMTP_PORT"] = "1025";
    env["GOTRUE_SMTP_ADMIN_EMAIL"] =
      input.mailpit.adminEmail ?? LEGACY_GOTRUE_DEFAULT_INBUCKET_ADMIN_EMAIL;
    env["GOTRUE_SMTP_SENDER_NAME"] =
      input.mailpit.senderName ?? LEGACY_GOTRUE_DEFAULT_INBUCKET_SENDER_NAME;
  }

  // Sessions — only emitted when the parsed duration is strictly positive.
  if (input.sessions?.timebox !== undefined) {
    const nanoseconds = legacyParseGoDuration(input.sessions.timebox);
    if (nanoseconds > 0) {
      env["GOTRUE_SESSIONS_TIMEBOX"] = legacyFormatGoDuration(nanoseconds);
    }
  }
  if (input.sessions?.inactivity_timeout !== undefined) {
    const nanoseconds = legacyParseGoDuration(input.sessions.inactivity_timeout);
    if (nanoseconds > 0) {
      env["GOTRUE_SESSIONS_INACTIVITY_TIMEOUT"] = legacyFormatGoDuration(nanoseconds);
    }
  }

  // Mailer template/notification URLs and subjects. `subject !== undefined`
  // is the "explicit empty string" vs "absent" distinction: the caller
  // (`legacyResolveAuthEmail`) has already recovered it from the raw
  // document, so `undefined` here means omit the env var entirely and `""`
  // means an explicit blank subject (still emit it).
  const addMailerEnvVars = (id: string, contentPath: string, subject: string | undefined): void => {
    if (contentPath.length > 0) {
      env[`GOTRUE_MAILER_TEMPLATES_${id.toUpperCase()}`] =
        `http://${input.kongContainerName}:${LEGACY_GOTRUE_NGINX_TEMPLATE_SERVER_PORT}/email/${id}${legacyFileExt(contentPath)}`;
    }
    if (subject !== undefined) {
      env[`GOTRUE_MAILER_SUBJECTS_${id.toUpperCase()}`] = subject;
    }
  };
  for (const [id, template] of Object.entries(input.email.template)) {
    addMailerEnvVars(id, template.content_path, template.subject);
  }
  for (const [id, notification] of Object.entries(input.email.notification)) {
    if (notification.enabled) {
      env[`GOTRUE_MAILER_NOTIFICATIONS_${id.toUpperCase()}_ENABLED`] = "true";
      addMailerEnvVars(`${id}_notification`, notification.content_path, notification.subject);
    }
  }

  // SMS provider switch — first enabled provider wins, in a fixed priority
  // order; a later enabled-but-lower-priority provider is never inspected.
  if (input.sms.twilio.enabled) {
    env["GOTRUE_SMS_PROVIDER"] = "twilio";
    env["GOTRUE_SMS_TWILIO_ACCOUNT_SID"] = input.sms.twilio.account_sid;
    env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"] = input.sms.twilio.auth_token ?? "";
    env["GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID"] = input.sms.twilio.message_service_sid;
  } else if (input.sms.twilio_verify.enabled) {
    env["GOTRUE_SMS_PROVIDER"] = "twilio_verify";
    env["GOTRUE_SMS_TWILIO_VERIFY_ACCOUNT_SID"] = input.sms.twilio_verify.account_sid ?? "";
    env["GOTRUE_SMS_TWILIO_VERIFY_AUTH_TOKEN"] = input.sms.twilio_verify.auth_token ?? "";
    env["GOTRUE_SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID"] =
      input.sms.twilio_verify.message_service_sid ?? "";
  } else if (input.sms.messagebird.enabled) {
    env["GOTRUE_SMS_PROVIDER"] = "messagebird";
    env["GOTRUE_SMS_MESSAGEBIRD_ACCESS_KEY"] = input.sms.messagebird.access_key ?? "";
    env["GOTRUE_SMS_MESSAGEBIRD_ORIGINATOR"] = input.sms.messagebird.originator ?? "";
  } else if (input.sms.textlocal.enabled) {
    env["GOTRUE_SMS_PROVIDER"] = "textlocal";
    env["GOTRUE_SMS_TEXTLOCAL_API_KEY"] = input.sms.textlocal.api_key ?? "";
    env["GOTRUE_SMS_TEXTLOCAL_SENDER"] = input.sms.textlocal.sender ?? "";
  } else if (input.sms.vonage.enabled) {
    env["GOTRUE_SMS_PROVIDER"] = "vonage";
    env["GOTRUE_SMS_VONAGE_API_KEY"] = input.sms.vonage.api_key ?? "";
    env["GOTRUE_SMS_VONAGE_API_SECRET"] = input.sms.vonage.api_secret ?? "";
    env["GOTRUE_SMS_VONAGE_FROM"] = input.sms.vonage.from ?? "";
  }

  // CAPTCHA.
  if (input.captcha !== undefined) {
    env["GOTRUE_SECURITY_CAPTCHA_ENABLED"] = String(input.captcha.enabled);
    env["GOTRUE_SECURITY_CAPTCHA_PROVIDER"] = input.captcha.provider ?? "";
    env["GOTRUE_SECURITY_CAPTCHA_SECRET"] = input.captcha.secret ?? "";
  }

  // Auth hooks — each independently gated on its own `enabled`.
  const appendHookEnv = (envPrefix: string, hook: LegacyGotrueHookInput): void => {
    if (!hook.enabled) return;
    env[`GOTRUE_HOOK_${envPrefix}_ENABLED`] = "true";
    env[`GOTRUE_HOOK_${envPrefix}_URI`] = hook.uri ?? "";
    env[`GOTRUE_HOOK_${envPrefix}_SECRETS`] = hook.secrets ?? "";
  };
  appendHookEnv("MFA_VERIFICATION_ATTEMPT", input.hooks.mfaVerificationAttempt);
  appendHookEnv("PASSWORD_VERIFICATION_ATTEMPT", input.hooks.passwordVerificationAttempt);
  appendHookEnv("CUSTOM_ACCESS_TOKEN", input.hooks.customAccessToken);
  appendHookEnv("SEND_SMS", input.hooks.sendSms);
  appendHookEnv("SEND_EMAIL", input.hooks.sendEmail);
  appendHookEnv("BEFORE_USER_CREATED", input.hooks.beforeUserCreated);

  // MFA phone extras — only when phone MFA is reachable at all.
  if (input.mfa.phone.enroll_enabled || input.mfa.phone.verify_enabled) {
    env["GOTRUE_MFA_PHONE_TEMPLATE"] = input.mfa.phone.template;
    env["GOTRUE_MFA_PHONE_OTP_LENGTH"] = String(input.mfa.phone.otp_length);
    env["GOTRUE_MFA_PHONE_MAX_FREQUENCY"] = legacyFormatGoDuration(
      legacyParseGoDuration(input.mfa.phone.max_frequency),
    );
  }

  // Passkey/WebAuthn, then external OAuth providers.
  legacyAppendGotruePasskeyEnv(env, input.passkeyEnabled, input.webauthn);
  legacyAppendGotrueExternalProviderEnv(env, input.externalProviders, jwtIssuer);

  // Web3 — always emitted, unconditionally.
  env["GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED"] = String(input.web3.solana.enabled);
  env["GOTRUE_EXTERNAL_WEB3_ETHEREUM_ENABLED"] = String(input.web3.ethereum.enabled);

  // OAuth server configuration.
  if (input.oauthServer.enabled) {
    env["GOTRUE_OAUTH_SERVER_ENABLED"] = String(input.oauthServer.enabled);
    env["GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH"] = input.oauthServer.authorization_url_path;
    env["GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION"] = String(
      input.oauthServer.allow_dynamic_registration,
    );
  }

  return env;
}

export interface LegacyGotrueContainerSpecInput {
  /** The already-resolved `config.auth.image`. Not part of the decoded `@supabase/config` schema; resolution is the caller's responsibility. */
  readonly image: string;
  /** The sanitized project id, used to derive this container's own name/the `db` container's own name via {@link legacyServiceContainerName}. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target — resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `LegacyLocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password (see {@link legacyStartInternalDbPassword}). */
  readonly dbUrl: string;
  /** Every value {@link legacyBuildGotrueEnv} needs, minus the two this builder derives itself (`dbHost`/`dbPassword`). */
  readonly env: Omit<LegacyBuildGotrueEnvInput, "dbHost" | "dbPassword">;
}

/**
 * Builds the `docker create` spec for the GoTrue/Auth container. No `ports`
 * (host-published) entry — GoTrue, like Realtime, only ever exposes its
 * port on the Docker network.
 */
export function legacyBuildGotrueContainerSpec(
  input: LegacyGotrueContainerSpecInput,
): LegacyStartContainerSpec {
  const dbHost = legacyServiceContainerName("db", input.projectId);
  const dbPassword = legacyStartInternalDbPassword(input.dbUrl);
  const env = legacyBuildGotrueEnv({ ...input.env, dbHost, dbPassword });

  return {
    image: input.image,
    containerName: legacyServiceContainerName(LEGACY_GOTRUE_CONTAINER_SUFFIX, input.projectId),
    env,
    binds: [],
    exposedPorts: [{ containerPort: LEGACY_GOTRUE_PORT }],
    healthcheck: legacyUsesSlimRuntime(input.image)
      ? legacySlimWgetHealthcheck(`http://127.0.0.1:${LEGACY_GOTRUE_PORT}/health`)
      : {
          test: [
            "CMD",
            "wget",
            "--no-verbose",
            "--tries=1",
            "--spider",
            `http://127.0.0.1:${LEGACY_GOTRUE_PORT}/health`,
          ],
          intervalSeconds: 10,
          timeoutSeconds: 2,
          retries: 3,
        },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [LEGACY_GOTRUE_CONTAINER_SUFFIX],
    labels: {},
  };
}

import type { ManagedConfigProperty, RemoteProjectConfig } from "./config-diff.ts";
import {
  coerceRemoteScalar,
  isRemoteRecord,
  managedScalar,
  managedStringList,
  remoteValueAt,
  type RemoteScalarKind,
} from "./config-diff.read.ts";

/**
 * The auth portion of the managed surface (`config-diff.managed.ts`). The v2
 * `auth` block is a flat record keyed by lowercased GoTrue setting name — the
 * same wire keys as the v1 `AuthConfigResponse`. Each entry maps one wire key
 * to its `auth.*` config.toml path, mirroring the Go CLI's
 * `FromRemoteAuthConfig` (`pkg/config/auth.go`): the same inversions
 * (`disable_signup`, `mailer_autoconfirm`), duration conversions (wire
 * seconds/hours to Go-style duration strings), and enum renames
 * (`password_required_characters`) apply.
 *
 * Deliberately unmanaged: local-only fields the API never reports
 * (`auth.enabled`, JWT key material, template `content_path`s,
 * `auth.external.*.redirect_uri`), `auth.third_party.*` (not part of the
 * gotrue config record), `auth.sms.test_otp` (a record-valued map, not a
 * leaf), and wire keys with no local schema path (`passkey_enabled`,
 * `webauthn_rp_*`, `external_figma_*`, SAML, OAuth server flags).
 */

function readAuthValue(remote: RemoteProjectConfig, key: string): unknown {
  return remoteValueAt(remote, "auth", [key]);
}

function authScalar(
  path: string,
  remoteKey: string,
  kind: RemoteScalarKind,
): ManagedConfigProperty {
  return managedScalar({ path, block: "auth", remotePath: [remoteKey], kind });
}

function authSecret(path: string, remoteKey: string): ManagedConfigProperty {
  return managedScalar({
    path,
    block: "auth",
    remotePath: [remoteKey],
    kind: "string",
    secret: true,
  });
}

/**
 * Inverted booleans: Go reads `EnableSignup = !DisableSignup` and
 * `EnableConfirmations = !MailerAutoconfirm`. Only an actual boolean is
 * negated; anything else (including "not returned") passes through so drift
 * against an unexpected wire shape is reported rather than swallowed.
 */
function readNegatedBoolean(remoteKey: string) {
  return (remote: RemoteProjectConfig): unknown => {
    const value = coerceRemoteScalar(readAuthValue(remote, remoteKey), "boolean");
    return typeof value === "boolean" ? !value : value;
  };
}

const GO_DURATION_UNIT_SECONDS = new Map<string, number>([
  ["ns", 1e-9],
  ["us", 1e-6],
  ["µs", 1e-6],
  ["ms", 1e-3],
  ["s", 1],
  ["m", 60],
  ["h", 3600],
]);

/**
 * Canonicalizes Go-style duration strings (`"1h30m"`, `"5s"`, `"0"`) to
 * seconds for comparison, matching `time.ParseDuration` for the non-negative
 * durations the schema uses. Unparseable strings pass through so they still
 * compare (and report) as-is.
 */
function normalizeGoDuration(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === "0") {
    return 0;
  }
  const component = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/y;
  let total = 0;
  let index = 0;
  while (index < trimmed.length) {
    component.lastIndex = index;
    const match = component.exec(trimmed);
    if (match === null) {
      return value;
    }
    total += Number(match[1]) * (GO_DURATION_UNIT_SECONDS.get(match[2]!) ?? 0);
    index = component.lastIndex;
  }
  return index > 0 ? total : value;
}

/**
 * A local Go-duration string fed by a wire number of seconds or hours (e.g.
 * `smtp_max_frequency` seconds, `sessions_timebox` hours). The remote value is
 * rendered as `"<n><unit>"` and both sides normalize through
 * {@link normalizeGoDuration}, so `"1h30m"` still equals a wire `1.5` hours.
 */
function authDuration(path: string, remoteKey: string, unit: "s" | "h"): ManagedConfigProperty {
  return {
    path,
    block: "auth",
    normalize: normalizeGoDuration,
    read: (remote) => {
      const value = coerceRemoteScalar(readAuthValue(remote, remoteKey), "number");
      return typeof value === "number" ? `${value}${unit}` : value;
    },
  };
}

/**
 * `password_required_characters` reports a character-class string; the local
 * schema stores an enum name (Go's `NewPasswordRequirement`). Unknown wire
 * values pass through unmapped so they surface as drift.
 */
const PASSWORD_REQUIREMENTS_BY_REQUIRED_CHARACTERS = new Map<string, string>([
  ["abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789", "letters_digits"],
  [
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    "lower_upper_letters_digits",
  ],
  [
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
    "lower_upper_letters_digits_symbols",
  ],
]);

// -- Core / site --------------------------------------------------------------

const CORE_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.site_url", "site_url", "string"),
  managedStringList({
    path: "auth.additional_redirect_urls",
    block: "auth",
    remotePath: ["uri_allow_list"],
  }),
  authScalar("auth.jwt_expiry", "jwt_exp", "number"),
  authScalar("auth.enable_refresh_token_rotation", "refresh_token_rotation_enabled", "boolean"),
  authScalar(
    "auth.refresh_token_reuse_interval",
    "security_refresh_token_reuse_interval",
    "number",
  ),
  authScalar("auth.enable_manual_linking", "security_manual_linking_enabled", "boolean"),
  // Go: `a.EnableSignup = !DisableSignup` (auth.go:454).
  { path: "auth.enable_signup", block: "auth", read: readNegatedBoolean("disable_signup") },
  authScalar("auth.enable_anonymous_sign_ins", "external_anonymous_users_enabled", "boolean"),
  authScalar("auth.minimum_password_length", "password_min_length", "number"),
  {
    path: "auth.password_requirements",
    block: "auth",
    read: (remote) => {
      const value = coerceRemoteScalar(
        readAuthValue(remote, "password_required_characters"),
        "string",
      );
      if (typeof value !== "string") {
        return value;
      }
      return PASSWORD_REQUIREMENTS_BY_REQUIRED_CHARACTERS.get(value) ?? value;
    },
  },
];

// -- Email --------------------------------------------------------------------

const EMAIL_TEMPLATE_NAMES = [
  "invite",
  "confirmation",
  "recovery",
  "magic_link",
  "email_change",
  "reauthentication",
];

const EMAIL_NOTIFICATION_NAMES = [
  "password_changed",
  "email_changed",
  "phone_changed",
  "identity_linked",
  "identity_unlinked",
  "mfa_factor_enrolled",
  "mfa_factor_unenrolled",
];

const EMAIL_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.email.enable_signup", "external_email_enabled", "boolean"),
  authScalar("auth.email.double_confirm_changes", "mailer_secure_email_change_enabled", "boolean"),
  // Go: `e.EnableConfirmations = !MailerAutoconfirm` (auth.go:825).
  {
    path: "auth.email.enable_confirmations",
    block: "auth",
    read: readNegatedBoolean("mailer_autoconfirm"),
  },
  authScalar(
    "auth.email.secure_password_change",
    "security_update_password_require_reauthentication",
    "boolean",
  ),
  authDuration("auth.email.max_frequency", "smtp_max_frequency", "s"),
  authScalar("auth.email.otp_length", "mailer_otp_length", "number"),
  authScalar("auth.email.otp_expiry", "mailer_otp_exp", "number"),
  // Go derives enablement from `smtp_host` presence: the platform clears every
  // SMTP field when custom SMTP is off (auth.go:1115: `Enabled = SmtpHost != nil`).
  {
    path: "auth.email.smtp.enabled",
    block: "auth",
    read: (remote) => {
      if (!isRemoteRecord(remote.auth)) {
        return undefined;
      }
      return readAuthValue(remote, "smtp_host") !== undefined;
    },
  },
  authScalar("auth.email.smtp.host", "smtp_host", "string"),
  // The wire reports the port as a string; the local schema types it a number.
  authScalar("auth.email.smtp.port", "smtp_port", "number"),
  authScalar("auth.email.smtp.user", "smtp_user", "string"),
  authSecret("auth.email.smtp.pass", "smtp_pass"),
  authScalar("auth.email.smtp.admin_email", "smtp_admin_email", "string"),
  authScalar("auth.email.smtp.sender_name", "smtp_sender_name", "string"),
  // Template subjects only: local templates store bodies as `content_path`
  // files, which the wire never reports.
  ...EMAIL_TEMPLATE_NAMES.map((name) =>
    authScalar(`auth.email.template.${name}.subject`, `mailer_subjects_${name}`, "string"),
  ),
  ...EMAIL_NOTIFICATION_NAMES.flatMap((name) => [
    authScalar(
      `auth.email.notification.${name}.enabled`,
      `mailer_notifications_${name}_enabled`,
      "boolean",
    ),
    authScalar(
      `auth.email.notification.${name}.subject`,
      `mailer_subjects_${name}_notification`,
      "string",
    ),
  ]),
];

// -- SMS ----------------------------------------------------------------------

/**
 * The wire reports a single `sms_provider`; Go fans it out to per-provider
 * `enabled` flags (auth.go:1207-1213). An empty provider reads as "not
 * returned" because Go leaves the local flags untouched in that case.
 */
function readSmsProviderEnabled(provider: string) {
  return (remote: RemoteProjectConfig): unknown => {
    const value = coerceRemoteScalar(readAuthValue(remote, "sms_provider"), "string");
    if (typeof value !== "string") {
      return value;
    }
    return value === "" ? undefined : value === provider;
  };
}

const SMS_PROVIDER_IDS = ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"];

const SMS_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.sms.enable_signup", "external_phone_enabled", "boolean"),
  authScalar("auth.sms.enable_confirmations", "sms_autoconfirm", "boolean"),
  authScalar("auth.sms.template", "sms_template", "string"),
  authDuration("auth.sms.max_frequency", "sms_max_frequency", "s"),
  ...SMS_PROVIDER_IDS.map((provider): ManagedConfigProperty => ({
    path: `auth.sms.${provider}.enabled`,
    block: "auth",
    read: readSmsProviderEnabled(provider),
  })),
  authScalar("auth.sms.twilio.account_sid", "sms_twilio_account_sid", "string"),
  authScalar("auth.sms.twilio.message_service_sid", "sms_twilio_message_service_sid", "string"),
  authSecret("auth.sms.twilio.auth_token", "sms_twilio_auth_token"),
  authScalar("auth.sms.twilio_verify.account_sid", "sms_twilio_verify_account_sid", "string"),
  authScalar(
    "auth.sms.twilio_verify.message_service_sid",
    "sms_twilio_verify_message_service_sid",
    "string",
  ),
  authSecret("auth.sms.twilio_verify.auth_token", "sms_twilio_verify_auth_token"),
  authScalar("auth.sms.messagebird.originator", "sms_messagebird_originator", "string"),
  authSecret("auth.sms.messagebird.access_key", "sms_messagebird_access_key"),
  authScalar("auth.sms.textlocal.sender", "sms_textlocal_sender", "string"),
  authSecret("auth.sms.textlocal.api_key", "sms_textlocal_api_key"),
  authScalar("auth.sms.vonage.from", "sms_vonage_from", "string"),
  authScalar("auth.sms.vonage.api_key", "sms_vonage_api_key", "string"),
  authSecret("auth.sms.vonage.api_secret", "sms_vonage_api_secret"),
];

// -- MFA ----------------------------------------------------------------------

const MFA_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.mfa.max_enrolled_factors", "mfa_max_enrolled_factors", "number"),
  authScalar("auth.mfa.totp.enroll_enabled", "mfa_totp_enroll_enabled", "boolean"),
  authScalar("auth.mfa.totp.verify_enabled", "mfa_totp_verify_enabled", "boolean"),
  authScalar("auth.mfa.phone.enroll_enabled", "mfa_phone_enroll_enabled", "boolean"),
  authScalar("auth.mfa.phone.verify_enabled", "mfa_phone_verify_enabled", "boolean"),
  authScalar("auth.mfa.phone.otp_length", "mfa_phone_otp_length", "number"),
  authScalar("auth.mfa.phone.template", "mfa_phone_template", "string"),
  authDuration("auth.mfa.phone.max_frequency", "mfa_phone_max_frequency", "s"),
  authScalar("auth.mfa.web_authn.enroll_enabled", "mfa_web_authn_enroll_enabled", "boolean"),
  authScalar("auth.mfa.web_authn.verify_enabled", "mfa_web_authn_verify_enabled", "boolean"),
];

// -- External OAuth providers ---------------------------------------------------

interface OAuthProviderSpec {
  readonly id: string;
  /** Wire reports `external_<id>_url` (azure, gitlab, keycloak, workos). */
  readonly url?: boolean;
  /** Wire reports `external_<id>_email_optional` (every provider but workos). */
  readonly emailOptional?: boolean;
  /** Wire splits extra client ids into `external_<id>_additional_client_ids`. */
  readonly additionalClientIds?: boolean;
  /** Wire reports `external_<id>_skip_nonce_check` (google only). */
  readonly skipNonceCheck?: boolean;
}

/**
 * The providers the local schema declares (`auth/providers.ts`), in schema
 * order. Go also maps `figma`, which the local schema does not model. The
 * local `redirect_uri` field (and `url`/`skip_nonce_check` on providers whose
 * wire block omits them) has no remote counterpart and stays unmanaged.
 */
const OAUTH_PROVIDERS: ReadonlyArray<OAuthProviderSpec> = [
  { id: "apple", additionalClientIds: true, emailOptional: true },
  { id: "azure", url: true, emailOptional: true },
  { id: "bitbucket", emailOptional: true },
  { id: "discord", emailOptional: true },
  { id: "facebook", emailOptional: true },
  { id: "github", emailOptional: true },
  { id: "gitlab", url: true, emailOptional: true },
  { id: "google", additionalClientIds: true, skipNonceCheck: true, emailOptional: true },
  { id: "kakao", emailOptional: true },
  { id: "keycloak", url: true, emailOptional: true },
  { id: "linkedin_oidc", emailOptional: true },
  { id: "notion", emailOptional: true },
  { id: "twitch", emailOptional: true },
  { id: "twitter", emailOptional: true },
  { id: "x", emailOptional: true },
  { id: "slack_oidc", emailOptional: true },
  { id: "spotify", emailOptional: true },
  { id: "workos", url: true },
  { id: "zoom", emailOptional: true },
];

function oauthProviderEntries(spec: OAuthProviderSpec): ReadonlyArray<ManagedConfigProperty> {
  const prefix = `auth.external.${spec.id}`;
  const wire = `external_${spec.id}`;
  const entries: Array<ManagedConfigProperty> = [
    authScalar(`${prefix}.enabled`, `${wire}_enabled`, "boolean"),
  ];
  if (spec.additionalClientIds === true) {
    // Go folds `additional_client_ids` back into the comma-joined local
    // `client_id` (auth.go:1415-1417, 1516-1518).
    entries.push({
      path: `${prefix}.client_id`,
      block: "auth",
      read: (remote) => {
        const clientId = coerceRemoteScalar(readAuthValue(remote, `${wire}_client_id`), "string");
        const additional = coerceRemoteScalar(
          readAuthValue(remote, `${wire}_additional_client_ids`),
          "string",
        );
        if (typeof clientId !== "string" || typeof additional !== "string" || additional === "") {
          return clientId;
        }
        return `${clientId},${additional}`;
      },
    });
  } else {
    entries.push(authScalar(`${prefix}.client_id`, `${wire}_client_id`, "string"));
  }
  entries.push(authSecret(`${prefix}.secret`, `${wire}_secret`));
  if (spec.url === true) {
    entries.push(authScalar(`${prefix}.url`, `${wire}_url`, "string"));
  }
  if (spec.skipNonceCheck === true) {
    entries.push(authScalar(`${prefix}.skip_nonce_check`, `${wire}_skip_nonce_check`, "boolean"));
  }
  if (spec.emailOptional === true) {
    entries.push(authScalar(`${prefix}.email_optional`, `${wire}_email_optional`, "boolean"));
  }
  return entries;
}

const EXTERNAL_PROPERTIES: ReadonlyArray<ManagedConfigProperty> =
  OAUTH_PROVIDERS.flatMap(oauthProviderEntries);

// -- Sessions -------------------------------------------------------------------

const SESSION_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authDuration("auth.sessions.timebox", "sessions_timebox", "h"),
  authDuration("auth.sessions.inactivity_timeout", "sessions_inactivity_timeout", "h"),
];

// -- Rate limits ----------------------------------------------------------------

const RATE_LIMIT_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.rate_limit.email_sent", "rate_limit_email_sent", "number"),
  authScalar("auth.rate_limit.sms_sent", "rate_limit_sms_sent", "number"),
  authScalar("auth.rate_limit.anonymous_users", "rate_limit_anonymous_users", "number"),
  authScalar("auth.rate_limit.token_refresh", "rate_limit_token_refresh", "number"),
  authScalar("auth.rate_limit.sign_in_sign_ups", "rate_limit_otp", "number"),
  authScalar("auth.rate_limit.token_verifications", "rate_limit_verify", "number"),
  authScalar("auth.rate_limit.web3", "rate_limit_web3", "number"),
];

// -- Captcha --------------------------------------------------------------------

const CAPTCHA_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.captcha.enabled", "security_captcha_enabled", "boolean"),
  authScalar("auth.captcha.provider", "security_captcha_provider", "string"),
  authSecret("auth.captcha.secret", "security_captcha_secret"),
];

// -- Web3 -----------------------------------------------------------------------

const WEB3_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  authScalar("auth.web3.solana.enabled", "external_web3_solana_enabled", "boolean"),
  authScalar("auth.web3.ethereum.enabled", "external_web3_ethereum_enabled", "boolean"),
];

// -- Hooks ----------------------------------------------------------------------

const HOOK_NAMES = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
];

const HOOK_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = HOOK_NAMES.flatMap((name) => [
  authScalar(`auth.hook.${name}.enabled`, `hook_${name}_enabled`, "boolean"),
  authScalar(`auth.hook.${name}.uri`, `hook_${name}_uri`, "string"),
  authSecret(`auth.hook.${name}.secrets`, `hook_${name}_secrets`),
]);

export const AUTH_MANAGED_CONFIG_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  ...CORE_PROPERTIES,
  ...EMAIL_PROPERTIES,
  ...SMS_PROPERTIES,
  ...MFA_PROPERTIES,
  ...EXTERNAL_PROPERTIES,
  ...SESSION_PROPERTIES,
  ...RATE_LIMIT_PROPERTIES,
  ...CAPTCHA_PROPERTIES,
  ...WEB3_PROPERTIES,
  ...HOOK_PROPERTIES,
];

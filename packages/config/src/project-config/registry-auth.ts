import { isObject } from "../config-document.ts";
import {
  clampToUint,
  expectBoolean,
  expectNumber,
  expectString,
  splitCommaSeparated,
  type ProjectConfigMappingRow,
} from "./registry-row.ts";

/**
 * GoTrue-key rows for the `auth` section of the v2 project-config
 * `data.attributes` — a flat `Record<string, Json>` keyed by lowercased
 * GoTrue setting name (e.g. `disable_signup`, `mfa_totp_enroll_enabled`).
 * Every row's `apiPath` therefore starts with `["auth", "<gotrue_key>"]` and
 * every `configPath` starts with `["auth", ...]`.
 *
 * Mined from the push-direction sync helpers in
 * `apps/cli/src/legacy/commands/config/push/config-sync/auth.sync.ts`
 * (`applyRemoteAuthConfig` and its `applyRemoteHook`/`applyRemoteProvider`
 * helpers for the pull direction, `authToUpdateBody` for the push direction)
 * — cited per row below — and verified against the config schema files under
 * `../auth/*.ts`. Local helpers below replicate the legacy shell's duration,
 * password-character, and env-map conversions since `packages/config` cannot
 * import from `apps/cli`.
 */

// Local helpers replicated from the legacy shell (see each citation).

/**
 * Port of Go `time.Duration.String()`, replicated from
 * `apps/cli/src/legacy/commands/config/push/config-sync/config-sync.duration.ts:18-82`.
 * Every call site below feeds it a whole multiple of a second or an hour, but
 * the full fractional-unit logic is copied verbatim so the output matches
 * that shared helper exactly rather than only on the inputs this file happens
 * to exercise today.
 */
function durationString(ns: number): string {
  if (ns === 0) return "0s";

  let result = "";
  const neg = ns < 0;
  if (neg) {
    result = "-";
    ns = -ns;
  }

  const hours = Math.floor(ns / 3_600_000_000_000);
  ns -= hours * 3_600_000_000_000;
  const minutes = Math.floor(ns / 60_000_000_000);
  ns -= minutes * 60_000_000_000;
  const secs = Math.floor(ns / 1_000_000_000);
  ns -= secs * 1_000_000_000;
  const ms = Math.floor(ns / 1_000_000);
  ns -= ms * 1_000_000;
  const us = Math.floor(ns / 1_000);
  ns -= us * 1_000;

  if (hours > 0) {
    result += `${hours}h${minutes}m${secs}s`;
    return result;
  }
  if (minutes > 0) {
    result += `${minutes}m${secs}s`;
    return result;
  }
  if (secs > 0) {
    if (ms > 0 || us > 0 || ns > 0) {
      const total_ns = secs * 1_000_000_000 + ms * 1_000_000 + us * 1_000 + ns;
      const secFloat = total_ns / 1_000_000_000;
      result += `${secFloat.toPrecision(10).replace(/\.?0+$/, "")}s`;
    } else {
      result += `${secs}s`;
    }
    return result;
  }
  if (ms > 0) {
    if (us > 0 || ns > 0) {
      const total_ns_ms = ms * 1_000_000 + us * 1_000 + ns;
      const msFloat = total_ns_ms / 1_000_000;
      result += `${msFloat.toPrecision(10).replace(/\.?0+$/, "")}ms`;
    } else {
      result += `${ms}ms`;
    }
    return result;
  }
  if (us > 0) {
    if (ns > 0) {
      const total_ns_us = us * 1_000 + ns;
      const usFloat = total_ns_us / 1_000;
      result += `${usFloat.toPrecision(10).replace(/\.?0+$/, "")}µs`;
    } else {
      result += `${us}µs`;
    }
    return result;
  }
  result += `${ns}ns`;
  return result;
}

/**
 * Seconds (integer, as reported by the API) → Go duration string. Used for
 * `email.max_frequency`, `mfa.phone.max_frequency`, and `sms.max_frequency`,
 * mirroring `secondsToDurationString` in `config-sync.duration.ts:161-167`.
 */
function secondsToDurationString(seconds: number): string {
  return durationString(seconds * 1_000_000_000);
}

/**
 * Hours (float, as reported by the API) → Go duration string. Used for
 * `sessions.timebox`/`sessions.inactivity_timeout`, mirroring the inline
 * `Math.round(hours) * 3_600_000_000_000` conversion in
 * `auth.sync.ts:1402-1407` (`applyRemoteAuthConfig`'s sessions block).
 */
function hoursToDurationString(hours: number): string {
  return durationString(Math.round(hours) * 3_600_000_000_000);
}

/**
 * Mirrors Go `strconv.ParseUint(s, 10, 16)`, replicated from `auth.sync.ts:
 * 2592-2601`: base-10 digits only, no sign, no suffix, value <= 65535.
 * Returns `undefined` on any parse error. Used for `email.smtp.port`, which
 * the API reports as a string. Unlike the legacy pull direction (which keeps
 * the previous local value on a parse failure, since it is merging into a
 * local document), this sparse mapping has no local value to fall back to,
 * so an unparsable port simply omits the field.
 */
function parseUint16(s: string): number | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number.parseInt(s, 10);
  return n > 65535 ? undefined : n;
}

/**
 * Port of Go `sms.fromAuthConfig`'s `envToMap`, replicated from
 * `auth.sync.ts:1736-1747`: splits on `,` (empty string → no entries, no
 * trimming — same as the shared `legacyStrToArr`,
 * `apps/cli/src/legacy/shared/legacy-local-config-values.ts:2790-2792`) then
 * each entry on the first `=`; entries without a `=` (or with `=` at index 0)
 * are dropped. Used for `sms.test_otp`.
 */
function envToMap(input: string): Record<string, string> {
  const entries = input.length === 0 ? [] : input.split(",");
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx > 0) {
      result[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
  }
  return result;
}

/**
 * Local config `password_requirements` enum → API `password_required_characters`
 * value, replicated verbatim from `auth.sync.ts:1241-1246` (Go
 * `PasswordRequirements.ToChar`) — the `:` separators between character-class
 * groups are significant, matching the `@supabase/api` generated client's
 * literals.
 */
const PASSWORD_REQUIREMENTS_TO_CHAR: Record<string, string> = {
  letters_digits: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits_symbols:
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
};

/** Inverse of {@link PASSWORD_REQUIREMENTS_TO_CHAR} (`auth.sync.ts:1248-1251`, Go `NewPasswordRequirement`). */
const CHAR_TO_PASSWORD_REQUIREMENTS: Record<string, string> = Object.fromEntries(
  Object.entries(PASSWORD_REQUIREMENTS_TO_CHAR).map(([requirement, char]) => [char, requirement]),
);

/**
 * Reads a sibling key from the flat `auth` attributes record for rows whose
 * `transform` combines more than one GoTrue key (declared via `alsoConsumes`).
 * `attributes` is the full `data.attributes` object, so this drills into its
 * `auth` sub-record first.
 */
function readAuthAttribute(attributes: Record<string, unknown>, key: string): unknown {
  const authAttributes = attributes["auth"];
  if (!isObject(authAttributes)) return undefined;
  return Object.hasOwn(authAttributes, key) ? authAttributes[key] : undefined;
}

// Row factories — see ./registry-row.ts for the null convention: `undefined`
// always skips a row, `null` skips unless the row has a `transform`. Every
// factory below (and every one-off row further down this file) therefore
// treats `null` as "omit" *before* narrowing the value with an `expect*`
// helper — narrowing a `null` first would throw `ProjectConfigParseError` for
// a value GoTrue legitimately reports, rather than skipping the field.

/**
 * Plain string passthrough. Needs its own `transform` (rather than none, as a
 * true passthrough would use) specifically so `null` is handled explicitly:
 * without a `transform`, the engine already omits a `null` row, but 54 GoTrue
 * keys route through this factory, and a future non-string, non-null value
 * (e.g. a nested object) must still throw via `expectString` rather than land
 * verbatim in the typed output.
 */
function stringRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? undefined : expectString(value, apiPath)),
  };
}

/** `x-secret` field: value omitted, path still counts as mapped. */
function secretRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  return { configPath, apiPath: ["auth", apiKey], isSecret: true };
}

function boolRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? undefined : expectBoolean(value, apiPath)),
  };
}

/**
 * Boolean field whose GoTrue name is the negation of the config field, e.g.
 * `disable_signup` → `enable_signup` (`auth.sync.ts:1272`, push inverse at
 * `:2299`) and `mailer_autoconfirm` → `email.enable_confirmations`
 * (`:1551`, push inverse at `:2379`).
 */
function invertedBoolRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? undefined : !expectBoolean(value, apiPath)),
    inverse: (value) => !value,
    unit: "inverted boolean",
  };
}

/** Signed API integer clamped to the schema's unsigned domain (`intToUint`). */
function uintRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? undefined : clampToUint(expectNumber(value, apiPath))),
  };
}

/** Integer seconds (API) → Go duration string (config), e.g. `"5s"`. */
function secondsDurationRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) =>
      value === null ? undefined : secondsToDurationString(expectNumber(value, apiPath)),
    unit: "seconds → duration string",
  };
}

/** Float hours (API) → Go duration string (config), e.g. `"1h0m0s"`. */
function hoursDurationRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) =>
      value === null ? undefined : hoursToDurationString(expectNumber(value, apiPath)),
    unit: "hours → duration string",
  };
}

// CORE (auth.sync.ts:1263-1276, applyRemoteAuthConfig's base scalar fields)

const coreRows: ReadonlyArray<ProjectConfigMappingRow> = [
  stringRow(["auth", "site_url"], "site_url"),
  {
    configPath: ["auth", "additional_redirect_urls"],
    apiPath: ["auth", "uri_allow_list"],
    transform: (value) =>
      value === null
        ? undefined
        : splitCommaSeparated(expectString(value, ["auth", "uri_allow_list"])),
    inverse: (value) => (Array.isArray(value) ? value.join(",") : value),
    unit: "csv → string[]",
  },
  uintRow(["auth", "jwt_expiry"], "jwt_exp"),
  boolRow(["auth", "enable_refresh_token_rotation"], "refresh_token_rotation_enabled"),
  uintRow(["auth", "refresh_token_reuse_interval"], "security_refresh_token_reuse_interval"),
  boolRow(["auth", "enable_manual_linking"], "security_manual_linking_enabled"),
  invertedBoolRow(["auth", "enable_signup"], "disable_signup"),
  boolRow(["auth", "enable_anonymous_sign_ins"], "external_anonymous_users_enabled"),
  uintRow(["auth", "minimum_password_length"], "password_min_length"),
  {
    configPath: ["auth", "password_requirements"],
    apiPath: ["auth", "password_required_characters"],
    // "" is a legitimate value (no character-class requirement); any other
    // non-string or unrecognized character-class string omits the field
    // rather than throwing, matching this package's leniency toward
    // API-ahead-of-package skew (ADR 0019, rule 2) — see auth.sync.ts:1259-1261.
    transform: (value) => {
      if (typeof value !== "string") return undefined;
      if (value === "") return "";
      return CHAR_TO_PASSWORD_REQUIREMENTS[value];
    },
    // auth.sync.ts:2302 (authToUpdateBody), the forward map.
    inverse: (value) => {
      if (typeof value !== "string" || value === "") return value;
      return PASSWORD_REQUIREMENTS_TO_CHAR[value];
    },
  },
];

// RATE LIMIT (auth.sync.ts:1291-1301; sign_in_sign_ups/token_verifications are renames)

const rateLimitRows: ReadonlyArray<ProjectConfigMappingRow> = [
  uintRow(["auth", "rate_limit", "anonymous_users"], "rate_limit_anonymous_users"),
  uintRow(["auth", "rate_limit", "token_refresh"], "rate_limit_token_refresh"),
  uintRow(["auth", "rate_limit", "sign_in_sign_ups"], "rate_limit_otp"),
  uintRow(["auth", "rate_limit", "token_verifications"], "rate_limit_verify"),
  uintRow(["auth", "rate_limit", "sms_sent"], "rate_limit_sms_sent"),
  // Deliberate divergence from the legacy apply: auth.sync.ts:1298 only
  // applies this field when local SMTP is enabled. A standalone mapping has
  // no local document to gate on, so it maps unconditionally.
  uintRow(["auth", "rate_limit", "email_sent"], "rate_limit_email_sent"),
  uintRow(["auth", "rate_limit", "web3"], "rate_limit_web3"),
];

// SESSIONS (auth.sync.ts:1400-1408)

const sessionsRows: ReadonlyArray<ProjectConfigMappingRow> = [
  hoursDurationRow(["auth", "sessions", "timebox"], "sessions_timebox"),
  hoursDurationRow(["auth", "sessions", "inactivity_timeout"], "sessions_inactivity_timeout"),
];

// EMAIL (auth.sync.ts:1548-1562)

const emailBaseRows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "email", "enable_signup"], "external_email_enabled"),
  boolRow(["auth", "email", "double_confirm_changes"], "mailer_secure_email_change_enabled"),
  invertedBoolRow(["auth", "email", "enable_confirmations"], "mailer_autoconfirm"),
  boolRow(
    ["auth", "email", "secure_password_change"],
    "security_update_password_require_reauthentication",
  ),
  uintRow(["auth", "email", "otp_length"], "mailer_otp_length"),
  uintRow(["auth", "email", "otp_expiry"], "mailer_otp_exp"),
  secondsDurationRow(["auth", "email", "max_frequency"], "smtp_max_frequency"),
];

// SMTP (auth.sync.ts:1410-1435; enabled/host share the smtp_host key)

const smtpRows: ReadonlyArray<ProjectConfigMappingRow> = [
  {
    // auth.sync.ts:1433 derives enabled from `smtp_host != null` (any non-null
    // host, including ""). This sparse mapping instead treats a non-empty
    // host as the signal, matching the push direction's own disable sentinel
    // (`body["smtp_host"] = ""` at auth.sync.ts:2387) so "" round-trips to
    // disabled on both sides of this registry.
    configPath: ["auth", "email", "smtp", "enabled"],
    apiPath: ["auth", "smtp_host"],
    transform: (value) => typeof value === "string" && value.length > 0,
  },
  {
    configPath: ["auth", "email", "smtp", "host"],
    apiPath: ["auth", "smtp_host"],
    transform: (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
  },
  {
    // auth.sync.ts:1420-1425: the API reports smtp_port as a string.
    configPath: ["auth", "email", "smtp", "port"],
    apiPath: ["auth", "smtp_port"],
    transform: (value) => (typeof value === "string" ? parseUint16(value) : undefined),
  },
  stringRow(["auth", "email", "smtp", "user"], "smtp_user"),
  stringRow(["auth", "email", "smtp", "admin_email"], "smtp_admin_email"),
  stringRow(["auth", "email", "smtp", "sender_name"], "smtp_sender_name"),
  secretRow(["auth", "email", "smtp", "pass"], "smtp_pass"),
];

// Email templates ×6 (auth.sync.ts:1439-1461; content_path has no API key)

const EMAIL_TEMPLATE_NAMES = [
  "invite",
  "confirmation",
  "recovery",
  "magic_link",
  "email_change",
  "reauthentication",
] as const;

const templateRows: ReadonlyArray<ProjectConfigMappingRow> = EMAIL_TEMPLATE_NAMES.map((name) =>
  stringRow(["auth", "email", "template", name, "subject"], `mailer_subjects_${name}`),
);

// Email notifications ×7 (auth.sync.ts:1491-1525)

const EMAIL_NOTIFICATION_NAMES = [
  "password_changed",
  "email_changed",
  "phone_changed",
  "identity_linked",
  "identity_unlinked",
  "mfa_factor_enrolled",
  "mfa_factor_unenrolled",
] as const;

const notificationRows: ReadonlyArray<ProjectConfigMappingRow> = EMAIL_NOTIFICATION_NAMES.flatMap(
  (name) => [
    boolRow(
      ["auth", "email", "notification", name, "enabled"],
      `mailer_notifications_${name}_enabled`,
    ),
    stringRow(
      ["auth", "email", "notification", name, "subject"],
      `mailer_subjects_${name}_notification`,
    ),
  ],
);

// MFA (auth.sync.ts:1381-1398)

const mfaRows: ReadonlyArray<ProjectConfigMappingRow> = [
  uintRow(["auth", "mfa", "max_enrolled_factors"], "mfa_max_enrolled_factors"),
  boolRow(["auth", "mfa", "totp", "enroll_enabled"], "mfa_totp_enroll_enabled"),
  boolRow(["auth", "mfa", "totp", "verify_enabled"], "mfa_totp_verify_enabled"),
  boolRow(["auth", "mfa", "phone", "enroll_enabled"], "mfa_phone_enroll_enabled"),
  boolRow(["auth", "mfa", "phone", "verify_enabled"], "mfa_phone_verify_enabled"),
  uintRow(["auth", "mfa", "phone", "otp_length"], "mfa_phone_otp_length"),
  stringRow(["auth", "mfa", "phone", "template"], "mfa_phone_template"),
  secondsDurationRow(["auth", "mfa", "phone", "max_frequency"], "mfa_phone_max_frequency"),
  boolRow(["auth", "mfa", "web_authn", "enroll_enabled"], "mfa_web_authn_enroll_enabled"),
  boolRow(["auth", "mfa", "web_authn", "verify_enabled"], "mfa_web_authn_verify_enabled"),
];

// CAPTCHA (auth.sync.ts:1303-1317)

const captchaRows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "captcha", "enabled"], "security_captcha_enabled"),
  {
    // Guarded to the schema enum (../auth/captcha.ts: "hcaptcha" | "turnstile");
    // any other value (including "" or null) omits the field rather than
    // throwing — auth.sync.ts:1309 has no such guard because it merges into a
    // local document instead of producing a standalone sparse one.
    configPath: ["auth", "captcha", "provider"],
    apiPath: ["auth", "security_captcha_provider"],
    transform: (value) => (value === "hcaptcha" || value === "turnstile" ? value : undefined),
  },
  secretRow(["auth", "captcha", "secret"], "security_captcha_secret"),
];

// WEB3 (auth.sync.ts:1695-1704)

const web3Rows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "web3", "solana", "enabled"], "external_web3_solana_enabled"),
  boolRow(["auth", "web3", "ethereum", "enabled"], "external_web3_ethereum_enabled"),
];

// SMS (auth.sync.ts:1674-1685)

const smsBaseRows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "sms", "enable_signup"], "external_phone_enabled"),
  // Not inverted: unlike mailer_autoconfirm/email.enable_confirmations
  // (auth.sync.ts:1551), sms_autoconfirm maps to sms.enable_confirmations
  // identically on both the pull (auth.sync.ts:1677) and push
  // (auth.sync.ts:2485) sides.
  boolRow(["auth", "sms", "enable_confirmations"], "sms_autoconfirm"),
  stringRow(["auth", "sms", "template"], "sms_template"),
  secondsDurationRow(["auth", "sms", "max_frequency"], "sms_max_frequency"),
  {
    // auth.sync.ts:1679, 1736-1747 (envToMap). Empty/null/unparsed → omit.
    configPath: ["auth", "sms", "test_otp"],
    apiPath: ["auth", "sms_test_otp"],
    transform: (value) => {
      if (typeof value !== "string" || value.length === 0) return undefined;
      const map = envToMap(value);
      return Object.keys(map).length > 0 ? map : undefined;
    },
  },
];

// SMS provider selection ×5 (auth.sync.ts:1663-1671, 1687: a single
// `sms_provider` string names exactly one active provider)
//
// Deliberate divergence from the legacy apply: auth.sync.ts:1643-1655 skips
// provider reconciliation entirely when the remote reports phone auth
// disabled and no local provider is already enabled. A standalone mapping
// has no local document to consult for "already enabled", so it reconciles
// unconditionally, for the same reason as the rate_limit.email_sent row
// above.

const SMS_PROVIDERS = ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"] as const;

const smsProviderSelectionRows: ReadonlyArray<ProjectConfigMappingRow> = SMS_PROVIDERS.map(
  (provider) => ({
    configPath: ["auth", "sms", provider, "enabled"],
    apiPath: ["auth", "sms_provider"],
    transform: (value) =>
      typeof value === "string" && value.length > 0 ? value === provider : undefined,
  }),
);

// SMS provider credentials (auth.sync.ts:1574-1672; vonage.api_key is NOT a
// secret — ../auth/sms.ts:286-292 has no `secret()` wrapper on it)

const smsCredentialRows: ReadonlyArray<ProjectConfigMappingRow> = [
  stringRow(["auth", "sms", "twilio", "account_sid"], "sms_twilio_account_sid"),
  stringRow(["auth", "sms", "twilio", "message_service_sid"], "sms_twilio_message_service_sid"),
  secretRow(["auth", "sms", "twilio", "auth_token"], "sms_twilio_auth_token"),
  stringRow(["auth", "sms", "twilio_verify", "account_sid"], "sms_twilio_verify_account_sid"),
  stringRow(
    ["auth", "sms", "twilio_verify", "message_service_sid"],
    "sms_twilio_verify_message_service_sid",
  ),
  secretRow(["auth", "sms", "twilio_verify", "auth_token"], "sms_twilio_verify_auth_token"),
  stringRow(["auth", "sms", "messagebird", "originator"], "sms_messagebird_originator"),
  secretRow(["auth", "sms", "messagebird", "access_key"], "sms_messagebird_access_key"),
  stringRow(["auth", "sms", "textlocal", "sender"], "sms_textlocal_sender"),
  secretRow(["auth", "sms", "textlocal", "api_key"], "sms_textlocal_api_key"),
  stringRow(["auth", "sms", "vonage", "from"], "sms_vonage_from"),
  stringRow(["auth", "sms", "vonage", "api_key"], "sms_vonage_api_key"),
  secretRow(["auth", "sms", "vonage", "api_secret"], "sms_vonage_api_secret"),
];

// HOOKS ×6 (auth.sync.ts:1319-1379; top-level config key is `hook`, singular
// — see ../auth/hooks.ts)

const AUTH_HOOK_NAMES = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
] as const;

const hookRows: ReadonlyArray<ProjectConfigMappingRow> = AUTH_HOOK_NAMES.flatMap((name) => [
  boolRow(["auth", "hook", name, "enabled"], `hook_${name}_enabled`),
  stringRow(["auth", "hook", name, "uri"], `hook_${name}_uri`),
  secretRow(["auth", "hook", name, "secrets"], `hook_${name}_secrets`),
]);

// EXTERNAL PROVIDERS (auth.sync.ts:1749-2000; provider set and per-field
// availability taken from ../auth/providers.ts and RemoteAuthConfig)
//
// Corrections against the mined field list:
//  - "figma" is a case in auth.sync.ts's remote-field switches
//    (getProviderEnabled et al., :1813-1814 and siblings) but
//    ../auth/providers.ts's `external` struct has no `figma` member, so no
//    row is emitted for it — the config schema cannot represent it.
//  - `url` only exists as an API field for azure/gitlab/keycloak/workos
//    (getProviderUrl, :1942-1955), even though the schema's `provider()`
//    struct declares a `url` field (with a default) for every provider.
//  - `email_optional` has no API field for workos specifically — absent from
//    both RemoteAuthConfig (:471-474) and getProviderEmailOptional's switch
//    (:1957-1998) — even though every other provider (including apple and
//    google) has one.

interface ExternalProviderSpec {
  readonly id: string;
  readonly hasUrl: boolean;
  readonly hasEmailOptional: boolean;
}

const EXTERNAL_PROVIDERS: ReadonlyArray<ExternalProviderSpec> = [
  { id: "apple", hasUrl: false, hasEmailOptional: true },
  { id: "azure", hasUrl: true, hasEmailOptional: true },
  { id: "bitbucket", hasUrl: false, hasEmailOptional: true },
  { id: "discord", hasUrl: false, hasEmailOptional: true },
  { id: "facebook", hasUrl: false, hasEmailOptional: true },
  { id: "github", hasUrl: false, hasEmailOptional: true },
  { id: "gitlab", hasUrl: true, hasEmailOptional: true },
  { id: "google", hasUrl: false, hasEmailOptional: true },
  { id: "kakao", hasUrl: false, hasEmailOptional: true },
  { id: "keycloak", hasUrl: true, hasEmailOptional: true },
  { id: "linkedin_oidc", hasUrl: false, hasEmailOptional: true },
  { id: "notion", hasUrl: false, hasEmailOptional: true },
  { id: "slack_oidc", hasUrl: false, hasEmailOptional: true },
  { id: "spotify", hasUrl: false, hasEmailOptional: true },
  { id: "twitch", hasUrl: false, hasEmailOptional: true },
  { id: "twitter", hasUrl: false, hasEmailOptional: true },
  { id: "x", hasUrl: false, hasEmailOptional: true },
  { id: "workos", hasUrl: true, hasEmailOptional: false },
  { id: "zoom", hasUrl: false, hasEmailOptional: true },
];

/**
 * Apple/Google fold a sibling `external_<id>_additional_client_ids` GoTrue
 * key into `client_id` (main + "," + additional, when the additional value
 * is a non-empty string) — auth.sync.ts:1764-1774.
 */
function providerClientIdRow(id: string): ProjectConfigMappingRow {
  const additionalKey = `external_${id}_additional_client_ids`;
  return {
    configPath: ["auth", "external", id, "client_id"],
    apiPath: ["auth", `external_${id}_client_id`],
    alsoConsumes: [["auth", additionalKey]],
    transform: (value, attributes) => {
      if (typeof value !== "string") return undefined;
      const additional = readAuthAttribute(attributes, additionalKey);
      if (typeof additional === "string" && additional.length > 0) {
        return `${value},${additional}`;
      }
      return value;
    },
  };
}

const externalProviderRows: ReadonlyArray<ProjectConfigMappingRow> = EXTERNAL_PROVIDERS.flatMap(
  (provider) => {
    const rows: Array<ProjectConfigMappingRow> = [
      boolRow(["auth", "external", provider.id, "enabled"], `external_${provider.id}_enabled`),
      provider.id === "apple" || provider.id === "google"
        ? providerClientIdRow(provider.id)
        : stringRow(
            ["auth", "external", provider.id, "client_id"],
            `external_${provider.id}_client_id`,
          ),
      secretRow(["auth", "external", provider.id, "secret"], `external_${provider.id}_secret`),
    ];
    if (provider.hasEmailOptional) {
      rows.push(
        boolRow(
          ["auth", "external", provider.id, "email_optional"],
          `external_${provider.id}_email_optional`,
        ),
      );
    }
    if (provider.hasUrl) {
      rows.push(stringRow(["auth", "external", provider.id, "url"], `external_${provider.id}_url`));
    }
    return rows;
  },
);

/** Google-only (auth.sync.ts:1783-1786). */
const googleSkipNonceCheckRow: ProjectConfigMappingRow = boolRow(
  ["auth", "external", "google", "skip_nonce_check"],
  "external_google_skip_nonce_check",
);

export const authMappingRows: ReadonlyArray<ProjectConfigMappingRow> = [
  ...coreRows,
  ...rateLimitRows,
  ...sessionsRows,
  ...emailBaseRows,
  ...smtpRows,
  ...templateRows,
  ...notificationRows,
  ...mfaRows,
  ...captchaRows,
  ...web3Rows,
  ...smsBaseRows,
  ...smsProviderSelectionRows,
  ...smsCredentialRows,
  ...hookRows,
  ...externalProviderRows,
  googleSkipNonceCheckRow,
];

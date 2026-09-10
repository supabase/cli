import { isObject } from "../config-document.ts";
import { setOwnProperty } from "../sparse.ts";
import {
  clampToUint,
  expectBoolean,
  expectInteger,
  expectNumberBetween,
  expectString,
  canonicalizeCommaJoinedArray,
  splitCommaSeparated,
  type ProjectConfigMappingRow,
} from "./registry-row.ts";

/**
 * GoTrue-key rows for the `auth` section of the v2 project-config `data.attributes` — a flat
 * `Record<string, Json>` keyed by lowercased GoTrue setting name. Every row's `apiPath` starts
 * with `["auth", "<gotrue_key>"]` and every `configPath` starts with `["auth", ...]`.
 *
 * Local helpers below replicate the CLI's duration, password-character, and env-map conversions,
 * since `packages/config` cannot import from `apps/cli`.
 */

/** Formats nanoseconds in Go duration syntax (`1h0m0.5s`), keeping fractional seconds. */
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

  const subSecondNs = ms * 1_000_000 + us * 1_000 + ns;
  // toFixed(9), not toPrecision: a sub-microsecond fraction under a whole second would stringify
  // in exponent notation under toPrecision, which Go duration syntax doesn't accept.
  const secondsText =
    subSecondNs > 0
      ? ((secs * 1_000_000_000 + subSecondNs) / 1_000_000_000)
          .toFixed(9)
          .replace(/0+$/, "")
          .replace(/\.$/, "")
      : `${secs}`;
  if (hours > 0) {
    result += `${hours}h${minutes}m${secondsText}s`;
    return result;
  }
  if (minutes > 0) {
    result += `${minutes}m${secondsText}s`;
    return result;
  }
  if (secs > 0) {
    result += `${secondsText}s`;
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

/** Go's maximum `time.Duration` (max int64 nanoseconds, ~292 years); 2^63 is the nearest exactly-representable float64 above it. */
const MAX_GO_DURATION_NS = 2 ** 63;

/**
 * Go's maximum duration in whole seconds, for the `*_max_frequency` rows: a single whole-unit
 * component stays float-exact at any magnitude in this range.
 */
const MAX_CANONICAL_DURATION_SECONDS = 9_223_372_036;

const NS_PER_SECOND = 1_000_000_000;
const NS_PER_MINUTE = 60 * NS_PER_SECOND;
const NS_PER_HOUR = 60 * NS_PER_MINUTE;
const NS_PER_MS = 1_000_000;
const NS_PER_US = 1_000;

/**
 * Ports Go's `time.ParseDuration`. Returns nanoseconds; throws on invalid input, and callers below
 * never let that throw escape (unparsable document values stay verbatim). For valid inputs the
 * fractional arithmetic matches the push pipeline's own float rounding, since canonicalization
 * exists to predict the value push actually produces, not a more "exact" reading it never performs.
 * Magnitude guards instead reject anything that would silently change a value by whole units.
 */
function parseDuration(s: string): number {
  if (s === "0") return 0;
  const orig = s;
  let neg = false;
  let total = 0;

  if (s.startsWith("-") || s.startsWith("+")) {
    neg = s.startsWith("-");
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s.length === 0) throw new Error(`time: invalid duration "${orig}"`);

  while (s.length > 0) {
    // consume leading integer/fractional digits
    let n = 0;
    let frac = 0;
    let post = 1;
    let i = 0;
    while (i < s.length && s.charAt(i) >= "0" && s.charAt(i) <= "9") {
      n = n * 10 + parseInt(s.charAt(i), 10);
      // An integer component past Number.MAX_SAFE_INTEGER has already
      // rounded during this very accumulation ("9007199254740993ns" reads
      // back as ...992), invisibly to the exactness check below — reject
      // here so the value stays verbatim instead of canonicalizing changed.
      if (n > Number.MAX_SAFE_INTEGER) {
        throw new Error(`time: invalid duration "${orig}" (value out of range)`);
      }
      i++;
    }
    const integerDigits = i;
    if (i < s.length && s.charAt(i) === ".") {
      i++;
      while (i < s.length && s.charAt(i) >= "0" && s.charAt(i) <= "9") {
        // Unbounded float accumulation, matching the push parser: its rounding of long fractions
        // is the pipeline's actual reading, so the canonicalizer reproduces it verbatim.
        frac = frac * 10 + parseInt(s.charAt(i), 10);
        post *= 10;
        i++;
      }
    }
    // Rejects a component with no digits at all (e.g. "s" or ".h"), so a malformed document value
    // stays verbatim instead of silently canonicalizing into "0s".
    if (integerDigits === 0 && post === 1) {
      throw new Error(`time: invalid duration "${orig}"`);
    }
    s = s.slice(i);
    if (s.length === 0) throw new Error(`time: missing unit in duration "${orig}"`);

    // consume unit
    let unitNs: number;
    if (s.startsWith("ns")) {
      unitNs = 1;
      s = s.slice(2);
    } else if (s.startsWith("us") || s.startsWith("µs")) {
      // Only the two spellings the push pipeline accepts; Go itself also takes Greek small mu
      // (U+03BC), but push throws on it, so that spelling stays verbatim instead.
      unitNs = NS_PER_US;
      s = s.slice(2);
    } else if (s.startsWith("ms")) {
      unitNs = NS_PER_MS;
      s = s.slice(2);
    } else if (s.startsWith("s")) {
      unitNs = NS_PER_SECOND;
      s = s.slice(1);
    } else if (s.startsWith("m")) {
      unitNs = NS_PER_MINUTE;
      s = s.slice(1);
    } else if (s.startsWith("h")) {
      unitNs = NS_PER_HOUR;
      s = s.slice(1);
    } else {
      throw new Error(`time: unknown unit in duration "${orig}"`);
    }

    // Any imprecision here is rejected below via the BigInt exactness check, never rounded;
    // rounding only applies to the fractional remainder (`fracNs`) next.
    const wholeContribution = n * unitNs;
    // A safe-integer component can still round through the unit multiplication; BigInt exactness
    // is the only reliable detector, and floats at these magnitudes are integers, so BigInt() is
    // total here.
    if (n !== 0 && BigInt(wholeContribution) !== BigInt(n) * BigInt(unitNs)) {
      throw new Error(`time: invalid duration "${orig}" (value out of range)`);
    }
    // Replicates the push parser's rounding exactly, since that's what actually processes the
    // document on push; Go's own ParseDuration rounds differently, toward a value push never
    // produces.
    const fracNs = Math.round((frac / post) * unitNs);
    // The addition itself can round onto a large exactly-scaled whole; on loss the value stays
    // verbatim.
    const contribution = wholeContribution + fracNs;
    if (fracNs !== 0 && contribution - wholeContribution !== fracNs) {
      throw new Error(`time: invalid duration "${orig}" (value out of range)`);
    }
    // Enforces two bounds: Go's int64 range, and float64 exactness — the running total must not
    // round, or the value stays verbatim rather than silently losing precision.
    const next = total + contribution;
    if (!Number.isFinite(next) || next > MAX_GO_DURATION_NS || next - total !== contribution) {
      throw new Error(`time: invalid duration "${orig}" (value out of range)`);
    }
    total = next;
  }

  // int64's asymmetry: +2^63 is one nanosecond past Go's maximum, while -2^63 is the valid
  // minimum, so only the positive case is rejected here.
  if (!neg && total === MAX_GO_DURATION_NS) {
    throw new Error(`time: invalid duration "${orig}" (value out of range)`);
  }

  return neg ? -total : total;
}

/**
 * Document-side duration canonicalization: a config document legally spells a duration as `"1m"`,
 * `"24h"`, or `"60s"`, while the API-side rows always emit the canonical Go form (`"1m0s"`).
 * Reparsing and re-emitting makes both sides converge on one spelling for one logical duration.
 * Never throws; an unparsable value is returned verbatim.
 */
function canonicalizeDurationString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return durationString(
      roundTripThroughHoursPayload(truncateLikePushFormatter(parseDuration(value))),
    );
  } catch {
    return value;
  }
}

/**
 * Replicates the push payload's own float quantization: session fields travel as fractional hours,
 * and the nanoseconds→hours→nanoseconds round trip isn't always exact, so the canonical document
 * spelling must ride the same round trip to match what the API arm reports after a push.
 */
function roundTripThroughHoursPayload(ns: number): number {
  const hours = ns / NS_PER_HOUR;
  const magnitudeNs = Math.round(Math.abs(hours) * NS_PER_HOUR);
  return hours < 0 ? -magnitudeNs : magnitudeNs;
}

/**
 * Replicates the push pipeline's own quantization of session durations: it drops the sub-second
 * remainder for magnitudes of a minute or more, and re-renders sub-minute-but-whole-second-or-more
 * values through the same `toPrecision(10)` rounding the push formatter uses. Below one second both
 * formatters agree, so the value passes through unchanged. {@link durationString} (the API arm)
 * stays Go-faithful instead, since a hosted value set out-of-band can genuinely carry sub-second
 * bits there.
 */
function truncateLikePushFormatter(ns: number): number {
  const magnitude = Math.abs(ns);
  if (magnitude >= NS_PER_MINUTE) {
    const wholeSeconds = Math.floor(magnitude / NS_PER_SECOND) * NS_PER_SECOND;
    return ns < 0 ? -wholeSeconds : wholeSeconds;
  }
  if (magnitude >= NS_PER_SECOND && magnitude % NS_PER_SECOND !== 0) {
    const rendered = (magnitude / NS_PER_SECOND)
      .toPrecision(10)
      .replace(/\.?0+$/, "")
      .replace(/\.$/, "");
    const quantized = parseDuration(`${rendered}s`);
    return ns < 0 ? -quantized : quantized;
  }
  return ns;
}

/**
 * {@link canonicalizeDurationString}, additionally floored to whole seconds, for the
 * `*_max_frequency` rows: the hosted value can only ever be whole seconds, so the document
 * spelling converges on what a push would actually produce.
 */
function canonicalizeWholeSecondsDurationString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    const wholeSeconds = Math.floor(parseDuration(value) / NS_PER_SECOND);
    return durationString(wholeSeconds * NS_PER_SECOND);
  } catch {
    return value;
  }
}

/** Seconds (integer, as reported by the API) → Go duration string. */
function secondsToDurationString(seconds: number): string {
  return durationString(seconds * 1_000_000_000);
}

/**
 * Hours (float, as reported by the API) → Go duration string, rendered faithfully rather than
 * rounded to whole hours: rounding would change the setting, break the push-side round trip
 * (which converts back to fractional hours), and hide real drift.
 */
function hoursToDurationString(hours: number): string {
  // Rounds to the nearest integer nanosecond rather than truncating, since a value that quantized
  // from an integer-nanosecond duration can land a hair below the original.
  // Magnitude first, sign second, matching `parseDuration`: a raw `Math.round` rounds half toward
  // +∞, which disagrees with that convention on negative half-nanosecond boundaries.
  const magnitudeNs = Math.round(Math.abs(hours) * 3_600_000_000_000);
  return durationString(hours < 0 ? -magnitudeNs : magnitudeNs);
}

/**
 * Parses a base-10, unsigned 16-bit port string (`email.smtp.port` arrives as a string); returns
 * `undefined` on any parse error, which the caller treats as omitting the field.
 */
function parseUint16(s: string): number | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number.parseInt(s, 10);
  return n > 65535 ? undefined : n;
}

/** Splits on `,` then each entry on the first `=`; entries without `=` are dropped. */
/**
 * Document-side canonicalization for `sms.test_otp`: serializes then re-parses through
 * {@link envToMap} so a key or value holding a literal comma converges on the value that
 * actually exists hosted after a push, instead of round-tripping into a different record.
 * Non-record or non-string-valued input passes through verbatim. An empty (or now-empty) record
 * normalizes to `undefined`, since the push wrapper omits the field entirely when the map is empty.
 */
function canonicalizeTestOtpMap(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }
  const entries = Object.entries(value);
  if (!entries.every(([, entryValue]) => typeof entryValue === "string")) {
    return value;
  }
  const canonical = envToMap(entries.map(([key, entryValue]) => `${key}=${entryValue}`).join(","));
  return Object.keys(canonical).length > 0 ? canonical : undefined;
}

function envToMap(input: string): Record<string, string> {
  const entries = input.length === 0 ? [] : input.split(",");
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx > 0) {
      setOwnProperty(result, entry.slice(0, eqIdx), entry.slice(eqIdx + 1));
    }
  }
  return result;
}

/**
 * Local config `password_requirements` enum → API `password_required_characters` value; the `:`
 * separators between character-class groups are significant.
 */
const PASSWORD_REQUIREMENTS_TO_CHAR: Record<string, string> = {
  letters_digits: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits_symbols:
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
};

/** Inverse of {@link PASSWORD_REQUIREMENTS_TO_CHAR}. */
const CHAR_TO_PASSWORD_REQUIREMENTS: Record<string, string> = Object.fromEntries(
  Object.entries(PASSWORD_REQUIREMENTS_TO_CHAR).map(([requirement, char]) => [char, requirement]),
);

/**
 * Reads a sibling key from the flat `auth` attributes record for rows whose `transform` combines
 * more than one GoTrue key (declared via `alsoConsumes`).
 */
function readAuthAttribute(attributes: Record<string, unknown>, key: string): unknown {
  const authAttributes = attributes["auth"];
  if (!isObject(authAttributes)) return undefined;
  return Object.hasOwn(authAttributes, key) ? authAttributes[key] : undefined;
}

// Every factory treats `null` as "omit" before narrowing the value with an `expect*` helper;
// narrowing a `null` first would throw for a value GoTrue legitimately reports, rather than
// skipping the field.

/**
 * Plain string passthrough. Declares its own `transform` (rather than none) so a non-string,
 * non-null value still throws via `expectString` instead of landing verbatim in typed output.
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
 * A gating boolean anchoring a disabled-sentinel prune (captcha, hooks, external providers).
 * Unlike {@link boolRow}, `null` maps to `false` here rather than being skipped: a disabled
 * feature's sentinel sweep only fires on a literal `false`, so dropping the `null` would leave a
 * retained sibling field in the projection with no `enabled` key.
 */
function gatedBoolRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? false : expectBoolean(value, apiPath)),
  };
}

/** Boolean field whose GoTrue name is the negation of the config field, e.g. `disable_signup` → `enable_signup`. */
function invertedBoolRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? undefined : !expectBoolean(value, apiPath)),
    unit: "inverted boolean",
  };
}

/**
 * Signed API integer clamped to the schema's unsigned domain. The document side clamps too: the
 * config schema accepts a negative value, but a pushed `-1` projects back as `0`, so the document
 * spelling must converge on that same reading.
 */
function uintRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? undefined : clampToUint(expectInteger(value, apiPath))),
    normalizeDocument: (value) => (typeof value === "number" ? clampToUint(value) : value),
  };
}

/**
 * Integer seconds (API) → Go duration string (config), e.g. `"5s"`. Narrowed with `expectInteger`,
 * not `expectNumber`: only the session-hour rows below are genuinely fractional.
 */
function secondsDurationRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) =>
      value === null
        ? undefined
        : secondsToDurationString(
            expectNumberBetween(
              expectInteger(value, apiPath),
              apiPath,
              -MAX_CANONICAL_DURATION_SECONDS,
              MAX_CANONICAL_DURATION_SECONDS,
            ),
          ),
    // Floors to whole seconds: the hosted value for these fields can only ever be whole seconds,
    // so the document spelling converges on what a push would actually produce.
    normalizeDocument: canonicalizeWholeSecondsDurationString,
    unit: "seconds → duration string",
  };
}

/** Float hours (API) → Go duration string (config), e.g. `"1h0m0s"`. */
/**
 * Bound for the session-hour fields: Go's maximum duration expressed in hours, so a value at the
 * ceiling still maps back exactly (whole-hour products stay float-exact at any magnitude in Go's
 * range). Signed, since these fields allow negative values, which render as `-Nh0m0s`.
 */
const MAX_SESSION_DURATION_HOURS = (MAX_GO_DURATION_NS - 2 ** 10) / NS_PER_HOUR;
// 2^63 - 1024 is exactly representable at that float spacing, keeping the inclusive bound below
// Go's maximum duration (2^63 itself is one nanosecond past it).

// Asymmetric like int64 itself: -2^63 ns is a valid Go duration (the minimum), so the floor
// includes it while the ceiling stops one nanosecond short of +2^63.
const MIN_SESSION_DURATION_HOURS = -(MAX_GO_DURATION_NS / NS_PER_HOUR);

function hoursDurationRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) =>
      value === null
        ? undefined
        : hoursToDurationString(
            expectNumberBetween(
              value,
              apiPath,
              MIN_SESSION_DURATION_HOURS,
              MAX_SESSION_DURATION_HOURS,
            ),
          ),
    normalizeDocument: canonicalizeDurationString,
    unit: "hours → duration string",
  };
}

// No `../auth/*.ts` section covers passkey/WebAuthn (`passkey_enabled`, `webauthn_rp_display_name`,
// `webauthn_rp_id`, `webauthn_rp_origins`), so no row targets either side; still reachable via
// `_apiResponse`.

const coreRows: ReadonlyArray<ProjectConfigMappingRow> = [
  { ...stringRow(["auth", "site_url"], "site_url"), dualScope: true },
  {
    configPath: ["auth", "additional_redirect_urls"],
    apiPath: ["auth", "uri_allow_list"],
    transform: (value) =>
      value === null
        ? undefined
        : splitCommaSeparated(expectString(value, ["auth", "uri_allow_list"])),
    normalizeDocument: canonicalizeCommaJoinedArray,
    // GoTrue treats the allow list as membership only; reordering the URLs changes nothing at
    // runtime.
    arrayEquality: "set",
    unit: "csv → string[]",
    dualScope: true,
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
    // "" means no character-class requirement; an unrecognized character-class string omits the
    // field (API-ahead skew), while a non-string still throws like every other mapped field.
    transform: (value) => {
      if (value === null) return undefined;
      const characters = expectString(value, ["auth", "password_required_characters"]);
      if (characters === "") return "";
      // Own entries only: a bare lookup with e.g. "constructor" would return the inherited
      // function instead of omitting the unrecognized charset.
      return Object.hasOwn(CHAR_TO_PASSWORD_REQUIREMENTS, characters)
        ? CHAR_TO_PASSWORD_REQUIREMENTS[characters]
        : undefined;
    },
  },
];

const rateLimitRows: ReadonlyArray<ProjectConfigMappingRow> = [
  uintRow(["auth", "rate_limit", "anonymous_users"], "rate_limit_anonymous_users"),
  uintRow(["auth", "rate_limit", "token_refresh"], "rate_limit_token_refresh"),
  uintRow(["auth", "rate_limit", "sign_in_sign_ups"], "rate_limit_otp"),
  uintRow(["auth", "rate_limit", "token_verifications"], "rate_limit_verify"),
  uintRow(["auth", "rate_limit", "sms_sent"], "rate_limit_sms_sent"),
  // Maps unconditionally: a standalone mapping has no local document to gate this on.
  uintRow(["auth", "rate_limit", "email_sent"], "rate_limit_email_sent"),
  uintRow(["auth", "rate_limit", "web3"], "rate_limit_web3"),
];

const sessionsRows: ReadonlyArray<ProjectConfigMappingRow> = [
  // GoTrue reports 0 hours for an unconfigured session bound, canonicalized to "0s"; declared as
  // the baseline so the diff recognizes it instead of flagging every untouched project.
  {
    ...hoursDurationRow(["auth", "sessions", "timebox"], "sessions_timebox"),
    unconfiguredValue: "0s",
  },
  {
    ...hoursDurationRow(["auth", "sessions", "inactivity_timeout"], "sessions_inactivity_timeout"),
    unconfiguredValue: "0s",
  },
];

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

const smtpHostPath = ["auth", "smtp_host"];
const smtpPortPath = ["auth", "smtp_port"];

const smtpRows: ReadonlyArray<ProjectConfigMappingRow> = [
  {
    // A non-empty host is the "enabled" signal, matching the push direction's own disable
    // sentinel (`smtp_host: ""`), so "" round-trips to disabled. `null` also means disabled; any
    // other non-string throws via `expectString`.
    configPath: ["auth", "email", "smtp", "enabled"],
    apiPath: smtpHostPath,
    transform: (value) => (value === null ? false : expectString(value, smtpHostPath).length > 0),
  },
  {
    // `null`/`""` omit the field (host is meaningless while SMTP is off); any other non-string
    // throws.
    configPath: ["auth", "email", "smtp", "host"],
    apiPath: smtpHostPath,
    transform: (value) => {
      if (value === null) return undefined;
      const host = expectString(value, smtpHostPath);
      return host.length > 0 ? host : undefined;
    },
    dualScope: true,
  },
  {
    // The API reports smtp_port as a string. `null` omits the field; a non-string throws; a
    // string `parseUint16` can't parse (out of range, non-digits) also omits. Gated on an enabled
    // SMTP host, like the sibling rows below.
    configPath: ["auth", "email", "smtp", "port"],
    apiPath: smtpPortPath,
    transform: (value, attributes) => {
      if (value === null) return undefined;
      const port = parseUint16(expectString(value, smtpPortPath));
      return smtpExplicitlyDisabledInAttributes(attributes) ? undefined : port;
    },
    // The config schema allows an unrestricted `Schema.Number` for port, but the push wrapper
    // stringifies it verbatim while this row's transform only ever produces what `parseUint16`
    // accepts. Replaying the same String→parseUint16 round trip here predicts that: a fractional
    // or out-of-range document port omits the field, matching what the API arm reports post-push.
    normalizeDocument: (value) => (typeof value === "number" ? parseUint16(String(value)) : value),
    dualScope: true,
  },
  smtpSiblingStringRow(["auth", "email", "smtp", "user"], "smtp_user"),
  smtpSiblingStringRow(["auth", "email", "smtp", "admin_email"], "smtp_admin_email"),
  smtpSiblingStringRow(["auth", "email", "smtp", "sender_name"], "smtp_sender_name"),
  secretRow(["auth", "email", "smtp", "pass"], "smtp_pass"),
];

/**
 * Whether the response explicitly reports SMTP disabled (a `null` or `""` `smtp_host`, the push
 * disable sentinel). An absent `smtp_host` normalizes to `undefined`, which does not gate the
 * sibling rows — a sparse response that never mentioned the host must still map them normally.
 */
function smtpExplicitlyDisabledInAttributes(attributes: Record<string, unknown>): boolean {
  const host = readAuthAttribute(attributes, "smtp_host");
  return host === null || host === "";
}

/** A {@link stringRow} gated on {@link smtpExplicitlyDisabledInAttributes} — validation still runs first. */
function smtpSiblingStringRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value, attributes) => {
      if (value === null) return undefined;
      const narrowed = expectString(value, apiPath);
      return smtpExplicitlyDisabledInAttributes(attributes) ? undefined : narrowed;
    },
    dualScope: true,
  };
}

const EMAIL_TEMPLATE_NAMES = [
  "invite",
  "confirmation",
  "recovery",
  "magic_link",
  "email_change",
  "reauthentication",
] as const;

const templateRows: ReadonlyArray<ProjectConfigMappingRow> = EMAIL_TEMPLATE_NAMES.map((name) => ({
  ...stringRow(["auth", "email", "template", name, "subject"], `mailer_subjects_${name}`),
  // A platform-rendered string with no meaningful local default; pinning a baseline breaks the
  // moment the platform rewords it.
  platformRendered: true,
}));

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
    {
      ...boolRow(
        ["auth", "email", "notification", name, "enabled"],
        `mailer_notifications_${name}_enabled`,
      ),
      // Every account-change notification defaults to disabled on the platform; the config
      // schema declares no default, so the diff baseline needs this reading.
      unconfiguredValue: false,
    },
    {
      ...stringRow(
        ["auth", "email", "notification", name, "subject"],
        `mailer_subjects_${name}_notification`,
      ),
      platformRendered: true,
    },
  ],
);

// The mailer template/notification CONTENT keys (as opposed to the SUBJECT keys mapped above,
// e.g. `mailer_templates_invite_content`) have no config-side field: the schema stores
// `content_path`, a filesystem path to the template body, never the rendered `content` itself,
// which exists only on the API side.

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

const captchaRows: ReadonlyArray<ProjectConfigMappingRow> = [
  gatedBoolRow(["auth", "captcha", "enabled"], "security_captcha_enabled"),
  {
    // Guarded to the schema enum ("hcaptcha" | "turnstile"): an unrecognized string (including
    // "") omits the field (API-ahead skew), `null` also omits, and a non-string throws.
    configPath: ["auth", "captcha", "provider"],
    apiPath: ["auth", "security_captcha_provider"],
    transform: (value) => {
      if (value === null) return undefined;
      const provider = expectString(value, ["auth", "security_captcha_provider"]);
      return provider === "hcaptcha" || provider === "turnstile" ? provider : undefined;
    },
    dualScope: true,
  },
  secretRow(["auth", "captcha", "secret"], "security_captcha_secret"),
];

// The GoTrue key `oauth_server_authorization_path` maps to the config field
// `authorization_url_path`.
const oauthServerRows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "oauth_server", "enabled"], "oauth_server_enabled"),
  boolRow(
    ["auth", "oauth_server", "allow_dynamic_registration"],
    "oauth_server_allow_dynamic_registration",
  ),
  stringRow(["auth", "oauth_server", "authorization_url_path"], "oauth_server_authorization_path"),
];

const web3Rows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "web3", "solana", "enabled"], "external_web3_solana_enabled"),
  boolRow(["auth", "web3", "ethereum", "enabled"], "external_web3_ethereum_enabled"),
];

const smsBaseRows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "sms", "enable_signup"], "external_phone_enabled"),
  // Not inverted, unlike mailer_autoconfirm: sms_autoconfirm maps to enable_confirmations directly.
  boolRow(["auth", "sms", "enable_confirmations"], "sms_autoconfirm"),
  stringRow(["auth", "sms", "template"], "sms_template"),
  secondsDurationRow(["auth", "sms", "max_frequency"], "sms_max_frequency"),
  uintRow(["auth", "sms", "otp_length"], "sms_otp_length"),
  uintRow(["auth", "sms", "otp_expiry"], "sms_otp_exp"),
  {
    // Null/empty/unparsed → omit; a present non-string throws like every other mapped field.
    configPath: ["auth", "sms", "test_otp"],
    apiPath: ["auth", "sms_test_otp"],
    transform: (value) => {
      if (value === null) return undefined;
      const encoded = expectString(value, ["auth", "sms_test_otp"]);
      if (encoded.length === 0) return undefined;
      const map = envToMap(encoded);
      return Object.keys(map).length > 0 ? map : undefined;
    },
    normalizeDocument: canonicalizeTestOtpMap,
    dualScope: true,
  },
];

// A single `sms_provider` string names exactly one active provider; reconciled unconditionally
// since a standalone mapping has no local document to consult for "already enabled". An
// unrecognized value maps every provider's `enabled` to `false` rather than surfacing as a bug —
// there's no single field to flag it against, but the raw string stays reachable at
// `_apiResponse.auth.sms_provider`.
const SMS_PROVIDERS = ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"] as const;

const smsProviderSelectionRows: ReadonlyArray<ProjectConfigMappingRow> = SMS_PROVIDERS.map(
  (provider) => ({
    configPath: ["auth", "sms", provider, "enabled"],
    apiPath: ["auth", "sms_provider"],
    // Null/empty → omit all five (no provider named); a non-string throws like every other
    // mapped field.
    transform: (value) => {
      if (value === null) return undefined;
      const named = expectString(value, ["auth", "sms_provider"]);
      return named.length > 0 ? named === provider : undefined;
    },
  }),
);

/**
 * Whether the response explicitly reports no active SMS provider (a `null` or `""`
 * `sms_provider`). An absent key does not gate — a sparse response that never mentioned the
 * provider says nothing about it.
 */
function smsProviderExplicitlyUnset(attributes: Record<string, unknown>): boolean {
  const provider = readAuthAttribute(attributes, "sms_provider");
  return provider === null || provider === "";
}

/**
 * A {@link stringRow} for a non-secret SMS provider credential, omitted when
 * {@link smsProviderExplicitlyUnset}. Without this, a retained credential under an explicitly
 * unset provider would survive as an unmanaged phantom entry, since the selection rows all omit
 * on null/"" too and leave nothing for an entry sweep to key on.
 */
function smsCredentialStringRow(
  configPath: ReadonlyArray<string>,
  apiKey: string,
): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value, attributes) => {
      if (value === null) return undefined;
      const narrowed = expectString(value, apiPath);
      return smsProviderExplicitlyUnset(attributes) ? undefined : narrowed;
    },
  };
}

// vonage.api_key isn't a secret field, unlike the other provider credentials below.
const smsCredentialRows: ReadonlyArray<ProjectConfigMappingRow> = [
  smsCredentialStringRow(["auth", "sms", "twilio", "account_sid"], "sms_twilio_account_sid"),
  smsCredentialStringRow(
    ["auth", "sms", "twilio", "message_service_sid"],
    "sms_twilio_message_service_sid",
  ),
  // Twilio-only: there's no `sms_twilio_verify_content_sid` counterpart.
  smsCredentialStringRow(["auth", "sms", "twilio", "content_sid"], "sms_twilio_content_sid"),
  secretRow(["auth", "sms", "twilio", "auth_token"], "sms_twilio_auth_token"),
  smsCredentialStringRow(
    ["auth", "sms", "twilio_verify", "account_sid"],
    "sms_twilio_verify_account_sid",
  ),
  smsCredentialStringRow(
    ["auth", "sms", "twilio_verify", "message_service_sid"],
    "sms_twilio_verify_message_service_sid",
  ),
  secretRow(["auth", "sms", "twilio_verify", "auth_token"], "sms_twilio_verify_auth_token"),
  smsCredentialStringRow(
    ["auth", "sms", "messagebird", "originator"],
    "sms_messagebird_originator",
  ),
  secretRow(["auth", "sms", "messagebird", "access_key"], "sms_messagebird_access_key"),
  smsCredentialStringRow(["auth", "sms", "textlocal", "sender"], "sms_textlocal_sender"),
  secretRow(["auth", "sms", "textlocal", "api_key"], "sms_textlocal_api_key"),
  smsCredentialStringRow(["auth", "sms", "vonage", "from"], "sms_vonage_from"),
  smsCredentialStringRow(["auth", "sms", "vonage", "api_key"], "sms_vonage_api_key"),
  secretRow(["auth", "sms", "vonage", "api_secret"], "sms_vonage_api_secret"),
];

// The top-level config key is singular: `hook`, not `hooks`.

// Exported so `../project-config.ts` can walk the same six names instead of keeping a second
// hand-copied list.
export const AUTH_HOOK_NAMES = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
] as const;

const hookRows: ReadonlyArray<ProjectConfigMappingRow> = AUTH_HOOK_NAMES.flatMap((name) => [
  gatedBoolRow(["auth", "hook", name, "enabled"], `hook_${name}_enabled`),
  stringRow(["auth", "hook", name, "uri"], `hook_${name}_uri`),
  secretRow(["auth", "hook", name, "secrets"], `hook_${name}_secrets`),
]);

// `url` exists as an API field only for azure/gitlab/keycloak/workos, and `email_optional` has no
// API field for workos specifically — both despite the schema declaring those fields for every
// provider. `skip_nonce_check` has no API field for any provider except google (handled
// separately below). Plain "slack" (unlike `slack_oidc`) has a real API field set but isn't a
// schema member: `../io.ts` strips `[auth.external.slack]` from a config before this schema sees it.

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
  { id: "figma", hasUrl: false, hasEmailOptional: true },
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

/** Apple/Google fold a sibling `external_<id>_additional_client_ids` GoTrue key into `client_id` (main + "," + additional, when non-empty). */
function providerClientIdRow(id: string): ProjectConfigMappingRow {
  const additionalKey = `external_${id}_additional_client_ids`;
  const apiPath = ["auth", `external_${id}_client_id`];
  const additionalApiPath = ["auth", additionalKey];
  return {
    configPath: ["auth", "external", id, "client_id"],
    apiPath,
    alsoConsumes: [additionalApiPath],
    transform: (value, attributes) => {
      // The sibling is validated first, even when the main ID is null, so a malformed additional
      // value isn't hidden from `unmappedApiFields`. `null` omits either key; a non-string throws.
      const additional = readAuthAttribute(attributes, additionalKey);
      const additionalIds =
        additional === undefined || additional === null
          ? undefined
          : expectString(additional, additionalApiPath);
      // `undefined` means the anchor key is absent but a consumed sibling is present; the sibling
      // was already validated above, so this bails like `null`.
      if (value === null || value === undefined) return undefined;
      const clientId = expectString(value, apiPath);
      return additionalIds !== undefined && additionalIds.length > 0
        ? `${clientId},${additionalIds}`
        : clientId;
    },
  };
}

const externalProviderRows: ReadonlyArray<ProjectConfigMappingRow> = EXTERNAL_PROVIDERS.flatMap(
  (provider) => {
    const rows: Array<ProjectConfigMappingRow> = [
      gatedBoolRow(["auth", "external", provider.id, "enabled"], `external_${provider.id}_enabled`),
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

/** Google-only. */
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
  ...oauthServerRows,
  ...web3Rows,
  ...smsBaseRows,
  ...smsProviderSelectionRows,
  ...smsCredentialRows,
  ...hookRows,
  ...externalProviderRows,
  googleSkipNonceCheckRow,
];

/**
 * GoTrue keys shaped like a secret (`_secret`, `_secrets`, `_auth_token`, `_api_secret`,
 * `_access_key`, or `_api_key`) with no registry row and no config-schema counterpart to give them
 * one — `unmappedApiFields` treats every listed path as mapped so an HMAC digest never appears
 * there just because a row doesn't exist. `sms_vonage_api_key` is excluded despite the suffix
 * since it isn't `x-secret` and already has an ordinary `stringRow`.
 */
export const unmappedSecretApiPaths: ReadonlyArray<ReadonlyArray<string>> = [
  ["auth", "external_figma_secret"],
  ["auth", "external_slack_secret"],
  ["auth", "hook_after_user_created_secrets"],
  ["auth", "nimbus_oauth_client_secret"],
];

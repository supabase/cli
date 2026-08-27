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
 * Port of Go `time.Duration.String()`, based on the legacy port at
 * `apps/cli/src/legacy/commands/config/push/config-sync/config-sync.duration.ts:18-82`,
 * with one DELIBERATE divergence: the legacy port truncates sub-second
 * remainders in its hours/minutes branches (its :39-45), where Go itself
 * prints fractional seconds (`"1h0m0.5s"`). This copy matches Go because it
 * renders the HOSTED value (the API arm must show sub-second bits a hosted
 * value can genuinely carry); the document-side canonicalizers instead apply
 * {@link truncateLikePushFormatter} first, since the push pipeline runs the
 * truncating formatter before converting (`normalizeDurationStr`,
 * auth.sync.ts:986-987) — the two arms then agree exactly on every value a
 * push can actually produce.
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

  const subSecondNs = ms * 1_000_000 + us * 1_000 + ns;
  // toFixed(9), not toPrecision: a sub-microsecond fraction under a whole
  // second (e.g. "1h1ns" => 1e-9 s) stringifies in exponent notation under
  // toPrecision, which Go duration syntax does not accept — Go prints
  // "1h0m0.000000001s" (up to nine decimals, trailing zeros trimmed).
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

/**
 * Go's maximum time.Duration (max int64 nanoseconds, ~292 years); 2^63 is
 * the nearest exactly-representable float64, one nanosecond above it — an
 * approximate guard whose only job is keeping values inside Go's domain.
 */
const MAX_GO_DURATION_NS = 2 ** 63;

/**
 * Go's maximum duration in whole seconds, for the `*_max_frequency` rows.
 * Values this large are single whole-unit components, which stay float-exact
 * at any magnitude inside Go's range (see {@link parseDuration}'s
 * precision rule) — only MIXED or FRACTIONAL components past
 * `Number.MAX_SAFE_INTEGER` nanoseconds lose precision.
 */
const MAX_CANONICAL_DURATION_SECONDS = 9_223_372_036;

const NS_PER_SECOND = 1_000_000_000;
const NS_PER_MINUTE = 60 * NS_PER_SECOND;
const NS_PER_HOUR = 60 * NS_PER_MINUTE;
const NS_PER_MS = 1_000_000;
const NS_PER_US = 1_000;

/**
 * Port of Go `time.ParseDuration`, based on the push parser at
 * `apps/cli/src/legacy/commands/config/push/config-sync/config-sync.duration.ts:95-159`
 * (the same file `durationString` above is ported from). Returns nanoseconds;
 * throws on invalid input — used only by the canonicalizers below, which
 * never let a throw escape (unparsable document values stay verbatim).
 *
 * SETTLED AUTHORITY SCOPING (after several review rounds pulled in opposite
 * directions): for VALID inputs the fractional-nanosecond arithmetic
 * replicates the push parser verbatim — its float rounding is the pipeline's
 * real reading, and canonicalization exists to predict the hosted value, so
 * a more "exact" result push would never produce is the wrong target. The
 * MAGNITUDE guards (digit-accumulation and whole-component exactness, the
 * Go-range bound) instead keep verbatim-on-loss semantics: there the
 * discrepancy changes a user-visible value by whole units, which
 * canonicalization must never do silently. Malformed inputs (digit-less
 * components, unknown units) throw here and stay verbatim, even though the
 * legacy parser tolerates some of them.
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
        // Unbounded float accumulation, exactly like the push parser
        // (config-sync.duration.ts:112-123): its rounding IS the pipeline's
        // reading of long fractions, so the canonicalizer must reproduce it
        // rather than a more exact result push would never produce.
        frac = frac * 10 + parseInt(s.charAt(i), 10);
        post *= 10;
        i++;
      }
    }
    // Go's ParseDuration rejects a component with no digits at all (`!pre &&
    // !post`, e.g. "s" or ".h") — the legacy port at
    // config-sync.duration.ts:107-125 omits that check and reads such input
    // as zero, which would let `canonicalizeDurationString` silently rewrite
    // a malformed document value like "s" into "0s". Failing here instead
    // leaves the document value verbatim (normalizeDocument's contract).
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
      // Only the two spellings the PUSH parser accepts (config-sync.
      // duration.ts:134): Go itself also takes Greek small mu (U+03BC), but
      // push throws on it, so canonicalizing "1μs" into a pushable "1µs"
      // would fabricate a reading the pipeline never performs — per the
      // authority scoping above, it stays verbatim instead.
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

    // Math.trunc, not round: Go's ParseDuration truncates fractional
    // nanoseconds ("1.0000000005s" reads as exactly 1s), and the legacy port
    // rounds — a deliberate match-Go divergence so canonicalization never
    // shifts a value by a nanosecond.
    // Go's exact operand order — `int64(f * (float64(unit) / scale))` — so
    // e.g. "0.2593ms" scales as 2593 * (1e6 / 1e4) = 259300 exactly, where
    // (frac / post) * unitNs rounds to 259299.99999999997 and truncates a
    // nanosecond short.
    const wholeContribution = n * unitNs;
    // A safe integer component can still round through the unit
    // multiplication ("9007199254740ms" × 1e6 lands above MAX_SAFE, and the
    // rounding can even divide back clean) — BigInt exactness is the only
    // reliable detector; on loss the value stays verbatim. Representable
    // floats at these magnitudes are integers, so BigInt() is total here.
    if (n !== 0 && BigInt(wholeContribution) !== BigInt(n) * BigInt(unitNs)) {
      throw new Error(`time: invalid duration "${orig}" (value out of range)`);
    }
    // The fractional arithmetic replicates the PUSH parser verbatim
    // (config-sync.duration.ts:155, `Math.round((frac / post) * unitNs)`):
    // that parser is what actually processes the document on push, so the
    // canonical spelling must predict ITS reading — Go's own ParseDuration
    // truncates and scales in the other operand order, but matching Go here
    // would canonicalize toward a hosted value the pipeline never produces.
    const fracNs = Math.round((frac / post) * unitNs);
    // The frac addition itself can round onto a large exactly-scaled whole
    // ("9000000000000.001ms": 9e18 + 1000 lands between float ticks) — on
    // loss the value stays verbatim.
    const contribution = wholeContribution + fracNs;
    if (fracNs !== 0 && contribution - wholeContribution !== fracNs) {
      throw new Error(`time: invalid duration "${orig}" (value out of range)`);
    }
    // Two bounds: Go's own int64 range, and float64 EXACTNESS — the addition
    // must not round ("2502h1ns" adds 1ns to a total whose float spacing is
    // already >1ns, so next - total comes back 0, not 1, and the value stays
    // verbatim rather than silently losing its tail), while exact additions
    // parse at any magnitude inside Go's range ("8760h", "8760h0m",
    // "8760h30m" — zero or coarse-grained components stay exact).
    const next = total + contribution;
    if (!Number.isFinite(next) || next > MAX_GO_DURATION_NS || next - total !== contribution) {
      throw new Error(`time: invalid duration "${orig}" (value out of range)`);
    }
    total = next;
  }

  // int64's own asymmetry: +2^63 is one nanosecond PAST Go's maximum while
  // -2^63 IS the valid minimum. The in-loop bound is strict (`>`), which
  // rightly lets the accumulation land exactly on 2^63 for the negative
  // endpoint — so the positive case must be rejected here, keeping the
  // document side in agreement with the API-side session ceiling (which
  // stops short of +2^63).
  if (!neg && total === MAX_GO_DURATION_NS) {
    throw new Error(`time: invalid duration "${orig}" (value out of range)`);
  }

  return neg ? -total : total;
}

/**
 * DOCUMENT-side duration canonicalization (CLI-2230's duration/byte-size
 * finding): a config document legally spells a duration as `"1m"`, `"24h"`,
 * or `"60s"` (the schema keeps every duration field a plain `Schema.String`),
 * while {@link secondsToDurationString}/{@link hoursToDurationString} always
 * emit the canonical Go form (`"1m0s"`). Reparsing and re-emitting through
 * `durationString`/`parseDuration` makes both sides converge on one spelling
 * for one logical duration. Never throws: a document value has already
 * passed schema validation, so an unparsable value (which should not occur)
 * is returned verbatim rather than failing `fromConfigDocument`.
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
 * The push payload's OWN float quantization, applied after
 * {@link truncateLikePushFormatter}: the session fields travel as fractional
 * HOURS — `durationToHours` is a bare `parseDuration(s) / 3.6e12`
 * (auth.sync.ts:2621-2627) — and {@link hoursToDurationString} maps the
 * hosted float back with `Math.round(|hours| * 3.6e12)`. That ns→hours→ns
 * trip is not always exact ("1024h4s" = 3,686,404,000,000,000 ns comes back
 * 1 ns high, rendering "1024h0m4.000000001s"), so the canonical document
 * spelling must ride the same round trip to land on the value the API arm
 * will actually report after a push. The arithmetic here mirrors
 * `hoursToDurationString` exactly (magnitude first, sign second).
 */
function roundTripThroughHoursPayload(ns: number): number {
  const hours = ns / NS_PER_HOUR;
  const magnitudeNs = Math.round(Math.abs(hours) * NS_PER_HOUR);
  return hours < 0 ? -magnitudeNs : magnitudeNs;
}

/**
 * The push pipeline's OWN quantization of session durations: the local
 * subset is built with `normalizeDurationStr` (auth.sync.ts:986-987), whose
 * formatter drops the sub-second remainder in its hours/minutes branches
 * (config-sync.duration.ts:39-45) before `durationToHours` converts what
 * remains (auth.sync.ts:2374-2375) — so a document `"1h0.5s"` stores exactly
 * one hour, and the canonical document spelling must predict that reading
 * (same convergence rule as the whole-second flooring for frequencies).
 * Sub-minute magnitudes with at least a whole second follow the legacy
 * SECONDS branch instead, which renders `toPrecision(10)` (config-sync.
 * duration.ts:47-55) — ten significant digits, not nine fixed decimals — so
 * `"59.123456789s"` pushes as `"59.12345679s"`; the quantized nanoseconds
 * are recovered by re-parsing that exact rendering through
 * {@link parseDuration}, which replicates the push parser's fractional
 * arithmetic verbatim. Below one second the two formatters' branches are
 * identical (both `toPrecision(10)`), so the value passes through. The
 * API-arm formatter ({@link durationString}) stays Go-faithful — a hosted
 * value set out-of-band CAN carry sub-second bits under an hour/minute
 * magnitude, and rendering them faithfully is what makes the resulting
 * drift honest (a push would quantize it away).
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
 * {@link canonicalizeDurationString}, additionally floored to whole seconds —
 * for the `*_max_frequency` rows, whose legacy push wrapper floors to integer
 * seconds (auth.sync.ts:2611-2616): the hosted value can only ever be whole
 * seconds, so the document spelling converges on what a push would actually
 * produce. Unparsable values stay verbatim, like the base canonicalizer.
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
 * `sessions.timebox`/`sessions.inactivity_timeout`. DELIBERATE divergence
 * from the legacy apply, which rounds to whole hours
 * (`Math.round(hours) * 3_600_000_000_000`, auth.sync.ts:1402-1407): a
 * standalone mapping must represent the hosted value faithfully — rounding
 * `1.5` hours to `"2h0m0s"` would change the setting, break the push-side
 * round-trip (which converts back to fractional hours), and hide real drift.
 */
function hoursToDurationString(hours: number): string {
  // Go durations are integer nanoseconds by definition, so the float product
  // resolves to the NEAREST integer nanosecond: an hour value that itself
  // came from quantizing an integer-nanosecond duration (pushing "65s"
  // stores 65e9/3.6e12 hours) can land a hair below the original, and
  // truncation would shave a nanosecond ("1m4.999999999s"); rounding repairs
  // that representation error while sub-nanosecond noise (sessions_timebox:
  // 1e-20 → exponent-notation "3.6e-8ns" under raw decomposition) still
  // collapses to "0s".
  // Magnitude first, sign second: both duration parsers round the absolute
  // value and then negate (parseDuration above; config-sync.duration.ts:
  // 101-104,155,158), while a raw Math.round rounds half toward +∞ — the two
  // disagree on negative half-nanosecond boundaries.
  const magnitudeNs = Math.round(Math.abs(hours) * 3_600_000_000_000);
  return durationString(hours < 0 ? -magnitudeNs : magnitudeNs);
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
/**
 * DOCUMENT-side canonicalization for `sms.test_otp` (same convergence rule
 * as the CSV-backed array rows): the push wrapper serializes the record as
 * `k=v` pairs joined by commas (`mapToEnv`, auth.sync.ts:2603-2609, used at
 * :2487) and the pull direction re-parses with {@link envToMap}, which
 * splits on EVERY comma and drops `=`-less fragments — so a key or value
 * holding a literal comma round-trips into a different record. Replaying
 * serialize-then-parse converges the document projection on the value that
 * actually exists hosted after a push. Non-record values or non-string
 * entries stay verbatim (document input has passed schema validation; never
 * throw here).
 *
 * A record that is (or parses back) EMPTY normalizes to `undefined` —
 * unmanaged absence: the push wrapper omits `sms_test_otp` entirely when the
 * serialized map is empty (auth.sync.ts:2487-2495), so an explicit
 * `test_otp: {}` can never clear a retained remote value; projecting `{}`
 * would fabricate permanent drift against the API arm (whose transform
 * likewise omits an empty map).
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
 * A GATING boolean — one that anchors a disabled-sentinel prune (captcha,
 * hooks, external providers). Unlike {@link boolRow}'s null-skip, `null` maps
 * to `false` here: the legacy reconciliation reads a null discriminator as
 * disabled (`valOrDefault(remote.security_captcha_enabled, false)`,
 * auth.sync.ts:1315; hooks `:1336`; providers `:1789`), the push path only
 * manages the sibling fields while enabled, and the sentinel sweep
 * (`applyDisabledSentinels`) only fires on a literal `false` — dropping the
 * null would leave a retained client_id/URI in the projection with no
 * `enabled` key, exactly the phantom-drift shape the sweep exists to prune.
 * Same shape as the SMTP anchor's `smtp_host: null → enabled: false`.
 */
function gatedBoolRow(configPath: ReadonlyArray<string>, apiKey: string): ProjectConfigMappingRow {
  const apiPath = ["auth", apiKey];
  return {
    configPath,
    apiPath,
    transform: (value) => (value === null ? false : expectBoolean(value, apiPath)),
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
    unit: "inverted boolean",
  };
}

/**
 * Signed API integer clamped to the schema's unsigned domain (`intToUint`).
 * The DOCUMENT side clamps too: the config schema's `Schema.Number` accepts
 * a negative value and the push mapper sends it unchanged (e.g.
 * auth.sync.ts:2304-2309), but the pull direction clamps whatever the API
 * reports — so a pushed `-1` projects back as `0`, and the document spelling
 * must converge on that same reading.
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
 * Integer seconds (API) → Go duration string (config), e.g. `"5s"`. Every
 * call site is one of the five duration rows CLI-2230's finding names, so
 * `normalizeDocument` is wired unconditionally here rather than per call
 * site. Narrowed with `expectInteger`, not `expectNumber`: the generated
 * contract declares all three `*_max_frequency` fields `isInt()`, so a
 * fractional value is a malformed platform response — only the session-hour
 * rows below are genuinely fractional.
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
    // Whole-second quantization, not just respelling: the legacy push
    // wrapper floors these three durations to integer seconds
    // (auth.sync.ts:2611-2616), so the hosted value can only ever be whole
    // seconds — a document "1.5s" pushes as 1s, and canonicalizing it to
    // "1s" makes the two sides converge on the value that actually exists.
    normalizeDocument: canonicalizeWholeSecondsDurationString,
    unit: "seconds → duration string",
  };
}

/**
 * Float hours (API) → Go duration string (config), e.g. `"1h0m0s"`. Every
 * call site is one of the five duration rows CLI-2230's finding names, so
 * `normalizeDocument` is wired unconditionally here rather than per call
 * site.
 */
/**
 * Bound for the session-hour fields: Go's maximum duration expressed in
 * (fractional) hours — a valid year-long "8760h" session bound pushes as
 * 8760 and must map back, so the ceiling is Go's range, not float precision
 * (whole-hour products stay exact at any magnitude inside it). Values past
 * it overflow the formatter ("InfinityhNaNmNaNs", exponent notation).
 * SIGNED: the strict contract only requires these fields finite, and the
 * legacy apply renders a negative value faithfully (`sessions_timebox: -1` →
 * `"-1h0m0s"`, auth.sync.ts:1402-1404 via durationString's sign handling),
 * with the push parser reading the leading `-` back (config-sync.duration.
 * ts:101-104,158) — like the signed `*_max_frequency` rows above, except the
 * floor reaches one nanosecond-equivalent further (int64's own asymmetry,
 * {@link MIN_SESSION_DURATION_HOURS} below).
 */
const MAX_SESSION_DURATION_HOURS = (MAX_GO_DURATION_NS - 2 ** 10) / NS_PER_HOUR;
// ^ 2^63 - 1024 (exactly representable at that float spacing) keeps the
// INCLUSIVE bound below Go's maximum duration — 2^63 itself is one
// nanosecond past max int64.

// Asymmetric like int64 itself: -2^63 ns IS a valid Go duration (the
// minimum), and the hours spelling of that endpoint rounds back to exactly
// -2^63 through the magnitude-then-sign conversion below (verified: the next
// more-negative float already products past 2^63 and stays rejected) — so
// the floor includes it while the ceiling stops short of +2^63.
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

// Legacy-handled but deliberately unmapped: the 4 passkey/webauthn keys
// (auth.sync.ts:281-285) — `passkey_enabled`, `webauthn_rp_display_name`,
// `webauthn_rp_id`, `webauthn_rp_origins`. `RemoteAuthConfig` carries them
// (the legacy shell's own `authSubsetFromConfig` sets its `passkey`/
// `webauthn` subset fields to `undefined` unconditionally, auth.sync.ts:
// 918-920, "not in @supabase/config schema"), but there is no
// `../auth/*.ts` section for passkey/WebAuthn at all, so no row can target
// either side. Still reachable via `_apiResponse`.

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
    normalizeDocument: canonicalizeCommaJoinedArray,
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
    // "" is a legitimate value (no character-class requirement) and an
    // unrecognized character-class STRING omits the field — an enum member
    // this package version doesn't model, tolerable API-ahead skew (ADR
    // 0019 rule 2; see auth.sync.ts:1259-1261). A present non-string,
    // however, is a malformed platform response and throws like every other
    // mapped auth field — silently omitting it would also let
    // `unmappedApiFields` hide the malformed value, since this path is
    // consumed. `null` keeps the no-value-omits convention.
    transform: (value) => {
      if (value === null) return undefined;
      const characters = expectString(value, ["auth", "password_required_characters"]);
      if (characters === "") return "";
      // Own entries only: the key is API-controlled, and a bare lookup with
      // e.g. "constructor" would return the inherited function instead of
      // omitting the unrecognized charset.
      return Object.hasOwn(CHAR_TO_PASSWORD_REQUIREMENTS, characters)
        ? CHAR_TO_PASSWORD_REQUIREMENTS[characters]
        : undefined;
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

const smtpHostPath = ["auth", "smtp_host"];
const smtpPortPath = ["auth", "smtp_port"];

const smtpRows: ReadonlyArray<ProjectConfigMappingRow> = [
  {
    // auth.sync.ts:1433 derives enabled from `smtp_host != null` (any non-null
    // host, including ""). This sparse mapping instead treats a non-empty
    // host as the signal, matching the push direction's own disable sentinel
    // (`body["smtp_host"] = ""` at auth.sync.ts:2387) so "" round-trips to
    // disabled on both sides of this registry. `null` keeps meaning
    // "disabled"; any other non-string throws via `expectString` rather than
    // silently reporting `enabled: false` for a value GoTrue never actually
    // sends.
    configPath: ["auth", "email", "smtp", "enabled"],
    apiPath: smtpHostPath,
    transform: (value) => (value === null ? false : expectString(value, smtpHostPath).length > 0),
  },
  {
    // Same null/non-string handling as `enabled` above — `null`/`""` omit the
    // field (host is meaningless while SMTP is off), any other non-string
    // throws.
    configPath: ["auth", "email", "smtp", "host"],
    apiPath: smtpHostPath,
    transform: (value) => {
      if (value === null) return undefined;
      const host = expectString(value, smtpHostPath);
      return host.length > 0 ? host : undefined;
    },
  },
  {
    // auth.sync.ts:1420-1425: the API reports smtp_port as a string. `null`
    // omits the field; a non-string throws via `expectString`; a string that
    // fails `parseUint16` (out of range, non-digits) still omits, per the
    // legacy pull direction's own tolerance for an unparsable port. Gated on
    // an enabled SMTP host (validation first), like the sibling rows below.
    configPath: ["auth", "email", "smtp", "port"],
    apiPath: smtpPortPath,
    transform: (value, attributes) => {
      if (value === null) return undefined;
      const port = parseUint16(expectString(value, smtpPortPath));
      return smtpEnabledInAttributes(attributes) ? port : undefined;
    },
  },
  smtpSiblingStringRow(["auth", "email", "smtp", "user"], "smtp_user"),
  smtpSiblingStringRow(["auth", "email", "smtp", "admin_email"], "smtp_admin_email"),
  smtpSiblingStringRow(["auth", "email", "smtp", "sender_name"], "smtp_sender_name"),
  secretRow(["auth", "email", "smtp", "pass"], "smtp_pass"),
];

/**
 * Whether the reported `smtp_host` signals SMTP enabled (non-null, non-empty)
 * — the sibling settings (`smtp_user`, `smtp_admin_email`, …) are stale noise
 * while SMTP is off: the push direction writes ONLY `smtp_host: ""` when
 * disabling (auth.sync.ts:2384-2397), so reporting retained siblings on a
 * disabled section would fabricate drift.
 */
function smtpEnabledInAttributes(attributes: Record<string, unknown>): boolean {
  const host = readAuthAttribute(attributes, "smtp_host");
  return typeof host === "string" && host.length > 0;
}

/** A {@link stringRow} gated on {@link smtpEnabledInAttributes} — validation still runs first. */
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
      return smtpEnabledInAttributes(attributes) ? narrowed : undefined;
    },
  };
}

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

// Legacy-handled but deliberately unmapped: the 13 mailer template/
// notification CONTENT keys (as opposed to the SUBJECT keys mapped above) —
// `mailer_templates_invite_content`, `mailer_templates_confirmation_content`,
// `mailer_templates_recovery_content`, `mailer_templates_magic_link_content`,
// `mailer_templates_email_change_content`,
// `mailer_templates_reauthentication_content` (the 6 templates, auth.sync.ts:
// 339-349), and `mailer_templates_password_changed_notification_content`,
// `mailer_templates_email_changed_notification_content`,
// `mailer_templates_phone_changed_notification_content`,
// `mailer_templates_identity_linked_notification_content`,
// `mailer_templates_identity_unlinked_notification_content`,
// `mailer_templates_mfa_factor_enrolled_notification_content`,
// `mailer_templates_mfa_factor_unenrolled_notification_content` (the 7
// notifications, auth.sync.ts:353-371). The config schema stores
// `content_path` (a filesystem path to the template body, `../auth/email.ts`)
// for each of these, never the rendered `content` itself, so there is no
// config-side field a row could target — `content` only exists on the
// GoTrue/API side, loaded from `content_path` at push time
// (`authSubsetFromConfig`'s `emailContent` parameter, auth.sync.ts:989-999).

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
  gatedBoolRow(["auth", "captcha", "enabled"], "security_captcha_enabled"),
  {
    // Guarded to the schema enum (../auth/captcha.ts: "hcaptcha" | "turnstile"):
    // an unrecognized STRING (including "") omits the field — an enum member
    // this version doesn't model, tolerable API-ahead skew — and `null` keeps
    // the no-value-omits convention, but a present non-string is a malformed
    // platform response and throws like every other mapped auth field.
    // auth.sync.ts:1309 has no guard at all because it merges into a local
    // document instead of producing a standalone sparse one.
    configPath: ["auth", "captcha", "provider"],
    apiPath: ["auth", "security_captcha_provider"],
    transform: (value) => {
      if (value === null) return undefined;
      const provider = expectString(value, ["auth", "security_captcha_provider"]);
      return provider === "hcaptcha" || provider === "turnstile" ? provider : undefined;
    },
  },
  secretRow(["auth", "captcha", "secret"], "security_captcha_secret"),
];

// OAUTH SERVER — no sync precedent (the section postdates the legacy
// mappers); name-matched against the generated contract
// (packages/api/src/generated/contracts.ts:3462-3464) and the config schema
// (../auth/index.ts:180-200). Note the rename: the GoTrue key is
// `oauth_server_authorization_path`, the config field
// `authorization_url_path`.

const oauthServerRows: ReadonlyArray<ProjectConfigMappingRow> = [
  boolRow(["auth", "oauth_server", "enabled"], "oauth_server_enabled"),
  boolRow(
    ["auth", "oauth_server", "allow_dynamic_registration"],
    "oauth_server_allow_dynamic_registration",
  ),
  stringRow(["auth", "oauth_server", "authorization_url_path"], "oauth_server_authorization_path"),
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
    // auth.sync.ts:1679, 1736-1747 (envToMap). Null/empty/unparsed → omit;
    // a present non-string is a malformed platform response and throws like
    // every other mapped auth field.
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
//
// An unrecognized `sms_provider` value (one that matches none of the five
// `=== provider` comparisons below) maps every provider's `enabled` to
// `false` — legacy-faithful (auth.sync.ts's switch is exactly these five
// `===` comparisons, with no fallback branch), not a bug. Unlike
// `pool_mode`'s `"statement"` case (`../registry.ts`), there is no single
// omitted field to point at: "phone auth is enabled with a provider this
// package version doesn't model" is invisible in the typed output entirely —
// every provider reading `false` looks identical to "no provider recognized"
// and to "phone auth genuinely uses none of these five". The raw string is
// still reachable at `_apiResponse.auth.sms_provider` — same bucket as
// `pool_mode`'s omitted enum member. A future report of unmapped/
// unrepresentable *values* (as opposed to unmapped *fields*, which
// `unmappedApiFields` already covers) would need to special-case this row.

const SMS_PROVIDERS = ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"] as const;

const smsProviderSelectionRows: ReadonlyArray<ProjectConfigMappingRow> = SMS_PROVIDERS.map(
  (provider) => ({
    configPath: ["auth", "sms", provider, "enabled"],
    apiPath: ["auth", "sms_provider"],
    // Null/empty → omit all five (no provider named); a present non-string
    // is a malformed platform response and throws, like every other mapped
    // auth field — silently omitting would also hide it from
    // `unmappedApiFields`, since this shared path is consumed.
    transform: (value) => {
      if (value === null) return undefined;
      const named = expectString(value, ["auth", "sms_provider"]);
      return named.length > 0 ? named === provider : undefined;
    },
  }),
);

/**
 * Whether the response EXPLICITLY reports no active SMS provider — a `null`
 * or `""` `sms_provider`, which legacy treats identically (`valOrDefault(
 * remote.sms_provider, "")` then `provider.length > 0`, auth.sync.ts:
 * 1664-1666). An ABSENT key does not gate: a sparse response that never
 * mentioned the provider says nothing about it, same absent-vs-sentinel rule
 * as `api.db_schema`'s `""` sentinel (`../registry.ts`).
 */
function smsProviderExplicitlyUnset(attributes: Record<string, unknown>): boolean {
  const provider = readAuthAttribute(attributes, "sms_provider");
  return provider === null || provider === "";
}

/**
 * A {@link stringRow} for a non-secret SMS provider credential, omitted when
 * {@link smsProviderExplicitlyUnset} — validation still runs first. Legacy
 * touches NEITHER the flags nor the credentials on a null/empty provider
 * (flag reconciliation is gated at auth.sync.ts:1664-1666, credentials read
 * only for the locally-selected provider, :1574-1655), so a retained
 * credential under an explicitly-unset provider must not project: the five
 * selection rows all omit on null/"" too, and with no `enabled: false` for
 * the entry sweep to key on, the credential would otherwise survive as an
 * unmanaged phantom entry.
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

// SMS provider credentials (auth.sync.ts:1574-1672; vonage.api_key is NOT a
// secret — ../auth/sms.ts:286-292 has no `secret()` wrapper on it)

const smsCredentialRows: ReadonlyArray<ProjectConfigMappingRow> = [
  smsCredentialStringRow(["auth", "sms", "twilio", "account_sid"], "sms_twilio_account_sid"),
  smsCredentialStringRow(
    ["auth", "sms", "twilio", "message_service_sid"],
    "sms_twilio_message_service_sid",
  ),
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
  gatedBoolRow(["auth", "hook", name, "enabled"], `hook_${name}_enabled`),
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
  const apiPath = ["auth", `external_${id}_client_id`];
  const additionalApiPath = ["auth", additionalKey];
  return {
    configPath: ["auth", "external", id, "client_id"],
    apiPath,
    alsoConsumes: [additionalApiPath],
    transform: (value, attributes) => {
      // The sibling is validated FIRST, even when the main ID is null: both
      // paths are marked consumed, so a malformed additional value behind a
      // null anchor would otherwise be hidden from `unmappedApiFields` too.
      // Null keeps the no-value-omits convention for either key; any other
      // non-string throws like every registry-mapped field.
      const additional = readAuthAttribute(attributes, additionalKey);
      const additionalIds =
        additional === undefined || additional === null
          ? undefined
          : expectString(additional, additionalApiPath);
      // Undefined = the anchor key is absent entirely — the engine still ran
      // this transform because a consumed sibling is present (see
      // applyMappingRows); the sibling was validated above, so bail like null.
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
 * API-side GoTrue keys shaped like a secret (suffix `_secret`, `_secrets`,
 * `_auth_token`, `_api_secret`, `_access_key`, or `_api_key`) that have no
 * registry row at all, verified exhaustively against the generated
 * Management API v1 auth-config contract
 * (`packages/api/src/generated/contracts.ts`'s `V1GetAuthServiceConfigOutput`
 * — the authority for this registry's key set, not the legacy hand-mined
 * `auth.sync.ts` interface, which is missing `external_slack` and
 * `nimbus_oauth` entirely) (CLI-2230's `unmappedApiFields` secret-leak
 * finding). Every OTHER secret-shaped GoTrue key already has an `isSecret`
 * row above and is therefore already excluded from `unmappedApiFields` on
 * its own merit; this list exists only for the ones that don't, so an HMAC
 * digest can't leak into that report just because this registry hasn't grown
 * a row for the field yet. `walkUnmapped` (`./project-config.ts`) treats
 * every path here as consumed, same as a row's `apiPath`/`alsoConsumes`.
 *
 * `sms_vonage_api_key` is deliberately excluded despite the `_api_key`
 * suffix: it is NOT `x-secret` on the config side (`../auth/sms.ts:286-292`
 * has no `secret()` wrapper on it — `smsCredentialRows`'s comment) and
 * already has an ordinary `stringRow`.
 *
 * Three orphans found, none with a config-schema counterpart at all:
 *  - `external_figma_secret`: `figma` is a GoTrue provider with no
 *    config-schema counterpart at all (`externalProviderRows`'s comment
 *    above), so it never gets a row of its own, secret or otherwise.
 *  - `external_slack_secret`: distinct from the mapped `slack_oidc` provider
 *    (`EXTERNAL_PROVIDERS`) — plain `slack` has no config-schema counterpart
 *    either.
 *  - `hook_after_user_created_secrets`: distinct from the mapped
 *    `before_user_created` hook (`AUTH_HOOK_NAMES`) — there is no
 *    `hook.after_user_created` config-schema section to target.
 *  - `nimbus_oauth_client_secret`: there is no `nimbus`-named external
 *    provider in the config schema at all.
 *
 * Guarded against regrowing a fourth orphan by
 * `apps/cli/src/shared/config/project-config-auth-contract.unit.test.ts`,
 * which walks the same generated contract's full key set, not just this
 * hand-maintained list.
 */
export const unmappedSecretApiPaths: ReadonlyArray<ReadonlyArray<string>> = [
  ["auth", "external_figma_secret"],
  ["auth", "external_slack_secret"],
  ["auth", "hook_after_user_created_secrets"],
  ["auth", "nimbus_oauth_client_secret"],
];

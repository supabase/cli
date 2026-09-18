/**
 * Duration string parsing and formatting matching Go's `time.ParseDuration()`/`Duration.String()`
 * grammar and rounding — the syntax the hosted API and container env vars expect.
 *
 * Several `config.toml` duration fields (e.g. `auth.sessions.timebox = "1h"`) are stored as the
 * raw string, but a container's env var is built from the parsed-then-reserialized value, which
 * normalizes it (`"1h"` becomes `"1h0m0s"`, `"90s"` becomes `"1m30s"`). A caller needing
 * byte-exact output must round-trip through both functions below, not pass the string through
 * unchanged.
 */

const NS_PER_SECOND = 1_000_000_000;
const NS_PER_MINUTE = 60 * NS_PER_SECOND;
const NS_PER_HOUR = 60 * NS_PER_MINUTE;
const NS_PER_MS = 1_000_000;
const NS_PER_US = 1_000;

// `BigInt` constants for `parseGoDuration`'s accumulator: near the int64 nanosecond ceiling
// (~9.223e18, past `Number.MAX_SAFE_INTEGER`), a `number` accumulator would silently round a
// legitimate boundary value into a false overflow or vice versa.
const NS_PER_SECOND_BIG = 1_000_000_000n;
const NS_PER_MINUTE_BIG = 60n * NS_PER_SECOND_BIG;
const NS_PER_HOUR_BIG = 60n * NS_PER_MINUTE_BIG;
const NS_PER_MS_BIG = 1_000_000n;
const NS_PER_US_BIG = 1_000n;

// Duration ceiling: `math.MaxInt64` nanoseconds (~292.47 years); the max parseable duration is
// `2562047h47m16.854775807s`.
const MAX_INT64_NS = 9223372036854775807n;

// The accumulator bound is `1<<63`, not `MAX_INT64_NS` (`1<<63-1`): a magnitude of exactly `1<<63`
// only overflows when the result is positive, since negating it wraps to exactly `math.MinInt64`.
// The stricter positive-only check runs after the loop, below.
const UINT64_ACCUMULATOR_BOUND_NS = 1n << 63n;

/**
 * Parses a Go-style duration string to nanoseconds: a possibly-signed sequence of decimal
 * numbers, each with a unit suffix (`"ns"`, `"us"`/`"µs"`/`"μs"`, `"ms"`, `"s"`, `"m"`, `"h"`), e.g.
 * `"5s"`, `"1h30m"`, `"300ms"`. Throws on invalid input, including an overflowing magnitude.
 *
 * Accumulates internally in `BigInt` (durations near the ceiling exceed
 * `Number.MAX_SAFE_INTEGER`) and only converts to `number` at the end — lossy that close to the
 * ceiling, but every real config duration is nowhere near it, and the overflow check itself
 * doesn't depend on `number` precision.
 */
export function parseGoDuration(value: string): number {
  const orig = value;
  let s = value;
  let neg = false;

  if (s.startsWith("-") || s.startsWith("+")) {
    neg = s.startsWith("-");
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s.length === 0) throw new Error(`time: invalid duration "${orig}"`);

  let total = 0n;
  while (s.length > 0) {
    // Require the next character to be `[0-9.]` before consuming a unit — otherwise a bare unit
    // like `"s"` would read zero digits and silently match anyway.
    if (!(s.charAt(0) === "." || (s.charAt(0) >= "0" && s.charAt(0) <= "9"))) {
      throw new Error(`time: invalid duration "${orig}"`);
    }
    let n = 0n;
    let frac = 0n;
    let post = 1n;
    let i = 0;
    while (i < s.length && s.charAt(i) >= "0" && s.charAt(i) <= "9") {
      n = n * 10n + BigInt(s.charAt(i));
      i++;
    }
    const hasIntDigits = i > 0;
    let hasFracDigits = false;
    if (i < s.length && s.charAt(i) === ".") {
      i++;
      const fracStart = i;
      while (i < s.length && s.charAt(i) >= "0" && s.charAt(i) <= "9") {
        frac = frac * 10n + BigInt(s.charAt(i));
        post *= 10n;
        i++;
      }
      hasFracDigits = i > fracStart;
    }
    // A lone `.` with no digits on either side (`".s"`, `"."`) is invalid, even though the
    // leading `[0-9.]` check above lets `.` start a valid fraction like `".5s"`.
    if (!hasIntDigits && !hasFracDigits) {
      throw new Error(`time: invalid duration "${orig}"`);
    }
    s = s.slice(i);
    if (s.length === 0) throw new Error(`time: missing unit in duration "${orig}"`);

    let unitNs: bigint;
    if (s.startsWith("ns")) {
      unitNs = 1n;
      s = s.slice(2);
    } else if (s.startsWith("us") || s.startsWith("µs") || s.startsWith("μs")) {
      // Accept all three microsecond spellings: "us", "µs" (U+00B5), and "μs" (U+03BC).
      unitNs = NS_PER_US_BIG;
      s = s.slice(2);
    } else if (s.startsWith("ms")) {
      unitNs = NS_PER_MS_BIG;
      s = s.slice(2);
    } else if (s.startsWith("s")) {
      unitNs = NS_PER_SECOND_BIG;
      s = s.slice(1);
    } else if (s.startsWith("m")) {
      unitNs = NS_PER_MINUTE_BIG;
      s = s.slice(1);
    } else if (s.startsWith("h")) {
      unitNs = NS_PER_HOUR_BIG;
      s = s.slice(1);
    } else {
      throw new Error(`time: unknown unit in duration "${orig}"`);
    }

    // The fractional remainder converts via a float64 multiplication then truncation, not an
    // exact BigInt division: once `frac` exceeds float64's 53-bit precision, rounding it to the
    // nearest representable double can push the product past the next integer, rounding up a
    // full unit where an exact-BigInt computation would truncate down (e.g.
    // `"0.999999999999999999s"` parses to exactly `1s`, not `999_999_999ns`). Converting to
    // `Number` before multiplying reproduces that same IEEE 754 round-to-nearest-even rounding.
    let term = n * unitNs;
    if (frac > 0n) {
      term += BigInt(Math.trunc(Number(frac) * (Number(unitNs) / Number(post))));
    }
    total += term;
    if (total > UINT64_ACCUMULATOR_BOUND_NS) {
      throw new Error(`time: invalid duration "${orig}"`);
    }
  }
  // Only a positive result gets the stricter post-loop bound; see `UINT64_ACCUMULATOR_BOUND_NS`
  // above for why a negative result may reach one nanosecond further.
  if (!neg && total > MAX_INT64_NS) {
    throw new Error(`time: invalid duration "${orig}"`);
  }

  return Number(neg ? -total : total);
}

/**
 * Formats nanoseconds as a Go-style duration string. `0` formats as `"0s"`; otherwise only the
 * needed units show, with minutes/seconds always trailing an hours component (`"1h0m0s"`), and a
 * sub-second remainder as a fraction of its largest applicable unit (`"1.5s"`, `"300ms"`).
 */
export function formatGoDuration(nanoseconds: number): string {
  if (nanoseconds === 0) return "0s";

  let ns = nanoseconds;
  const neg = ns < 0;
  if (neg) ns = -ns;

  const hours = Math.floor(ns / NS_PER_HOUR);
  ns -= hours * NS_PER_HOUR;
  const minutes = Math.floor(ns / NS_PER_MINUTE);
  ns -= minutes * NS_PER_MINUTE;
  const secs = Math.floor(ns / NS_PER_SECOND);
  ns -= secs * NS_PER_SECOND;
  const ms = Math.floor(ns / NS_PER_MS);
  ns -= ms * NS_PER_MS;
  const us = Math.floor(ns / NS_PER_US);
  ns -= us * NS_PER_US;

  const sign = neg ? "-" : "";

  if (hours > 0 || minutes > 0) {
    const secsStr =
      ms > 0 || us > 0 || ns > 0
        ? formatFraction(secs * NS_PER_SECOND + ms * NS_PER_MS + us * NS_PER_US + ns, NS_PER_SECOND)
        : `${secs}`;
    if (hours > 0) return `${sign}${hours}h${minutes}m${secsStr}s`;
    return `${sign}${minutes}m${secsStr}s`;
  }
  if (secs > 0) {
    if (ms > 0 || us > 0 || ns > 0) {
      const totalNs = secs * NS_PER_SECOND + ms * NS_PER_MS + us * NS_PER_US + ns;
      return `${sign}${formatFraction(totalNs, NS_PER_SECOND)}s`;
    }
    return `${sign}${secs}s`;
  }
  if (ms > 0) {
    if (us > 0 || ns > 0) {
      const totalNs = ms * NS_PER_MS + us * NS_PER_US + ns;
      return `${sign}${formatFraction(totalNs, NS_PER_MS)}ms`;
    }
    return `${sign}${ms}ms`;
  }
  if (us > 0) {
    if (ns > 0) {
      const totalNs = us * NS_PER_US + ns;
      return `${sign}${formatFraction(totalNs, NS_PER_US)}µs`;
    }
    return `${sign}${us}µs`;
  }
  return `${sign}${ns}ns`;
}

/** Formats `totalNs / unitNs` with trailing zeros (and a trailing `.`) trimmed. */
function formatFraction(totalNs: number, unitNs: number): string {
  return (totalNs / unitNs).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Seconds form of a `Db.HealthTimeout` duration string (`"2m"` default). Throws on a malformed
 * value, matching {@link parseGoDuration}; the caller wraps that into a typed config-load-failure
 * error so rollback/cleanup still fires. A degenerate value like `"0s"` isn't special-cased: it
 * means exactly one immediate health probe with no wait, not a 30s fallback.
 */
export function resolveHealthTimeoutSeconds(healthTimeout: string): number {
  return Math.trunc(parseGoDuration(healthTimeout) / 1_000_000_000);
}

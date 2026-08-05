/**
 * Go `time.Duration` string parsing and formatting, ported from Go's
 * `src/time/time.go` `time.ParseDuration()` and `Duration.String()`.
 *
 * Several `config.toml` fields decode in `@supabase/config` as the raw
 * duration STRING (e.g. `auth.sessions.timebox = "1h"`,
 * `auth.sms.max_frequency = "5s"`) rather than Go's parsed `time.Duration`
 * (nanoseconds as `int64`). Go itself re-serializes the PARSED value with
 * `fmt.Sprintf("%v", duration)` when building a container's env (e.g.
 * `GOTRUE_SESSIONS_TIMEBOX`, `GOTRUE_SMS_MAX_FREQUENCY` in
 * `apps/cli-go/internal/start/start.go`'s `buildGotrueEnv`, deleted along with
 * the rest of `internal/start` as unreachable, CLI-1966; last present at
 * commit a253ccba2), which normalizes
 * the string to Go's canonical form — `"1h"` becomes `"1h0m0s"`,
 * `"90s"` becomes `"1m30s"` — so callers needing byte-exact parity must
 * round-trip through both functions below, not just pass the configured
 * string through unchanged.
 */

const NS_PER_SECOND = 1_000_000_000;
const NS_PER_MINUTE = 60 * NS_PER_SECOND;
const NS_PER_HOUR = 60 * NS_PER_MINUTE;
const NS_PER_MS = 1_000_000;
const NS_PER_US = 1_000;

// `legacyParseGoDuration`'s own accumulator needs exact integer arithmetic near Go's `int64`
// nanosecond ceiling (~9.223e18) — that magnitude is already ~1000x past `Number.MAX_SAFE_INTEGER`
// (2^53 ≈ 9.007e15), so a plain `number` accumulator (as used by `legacyFormatGoDuration` below,
// which never approaches this magnitude for real durations) silently rounds to the nearest
// representable float64, which can flip a legitimate boundary value into a false overflow or vice
// versa. `BigInt` constants, distinct from the `NS_PER_*` `number`s above, exist only for this.
const NS_PER_SECOND_BIG = 1_000_000_000n;
const NS_PER_MINUTE_BIG = 60n * NS_PER_SECOND_BIG;
const NS_PER_HOUR_BIG = 60n * NS_PER_MINUTE_BIG;
const NS_PER_MS_BIG = 1_000_000n;
const NS_PER_US_BIG = 1_000n;

// Go's `time.Duration` ceiling (`math.MaxInt64` nanoseconds, ~292.47 years) — `time.ParseDuration`
// rejects any value whose accumulated nanosecond count would exceed this. Go's real max parseable
// duration is `2562047h47m16.854775807s`.
const MAX_INT64_NS = 9223372036854775807n;

/**
 * Port of Go `time.ParseDuration`. Returns nanoseconds as a number. Accepts
 * the same grammar Go does: a possibly-signed sequence of decimal numbers,
 * each with a unit suffix (`"ns"`, `"us"`/`"µs"`, `"ms"`, `"s"`, `"m"`, `"h"`),
 * e.g. `"5s"`, `"1h30m"`, `"300ms"`. Throws on invalid input, matching Go's
 * own `errors.New("time: invalid duration ...")` failure mode — including
 * overflowing `math.MaxInt64` nanoseconds and a fractional remainder that
 * would truncate to a sub-nanosecond value.
 *
 * Accumulates internally in `BigInt`, not `number`: durations near Go's real
 * max are already well past `Number.MAX_SAFE_INTEGER`, so a `number`
 * accumulator can silently round a legitimate boundary value into a false
 * overflow (or the reverse) well before the final overflow check ever runs.
 * Only the RETURNED value converts to `number` (at the very end), which is
 * lossy for a duration this close to the ceiling — an accepted, proportionate
 * limit given every real config duration (seconds-hours) is nowhere near it,
 * and the exactness that actually matters — whether an out-of-range override
 * gets rejected like Go rejects it — no longer depends on `number` precision
 * at all.
 */
export function legacyParseGoDuration(value: string): number {
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
    // Go requires the next character to be `[0-9.]` before consuming a unit
    // (`time.ParseDuration`'s `if !(s[0] == '.' || '0' <= s[0] && s[0] <= '9')`
    // guard) — without this check, a bare unit like `"s"` or `"m"` would read
    // zero digits, skip the "missing unit" guard below (since `s` is still
    // non-empty), and silently match the unit anyway.
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
    // Go's `pre`/`post` guard: a lone `.` with no digits on either side
    // (`".s"`, `"."`, `"-."`) is invalid — the leading `[0-9.]` check above lets
    // `.` through (it's the first character of a valid fraction like `".5s"`),
    // but a `.` that consumes zero digits before AND after it must still fail.
    if (!hasIntDigits && !hasFracDigits) {
      throw new Error(`time: invalid duration "${orig}"`);
    }
    s = s.slice(i);
    if (s.length === 0) throw new Error(`time: missing unit in duration "${orig}"`);

    let unitNs: bigint;
    if (s.startsWith("ns")) {
      unitNs = 1n;
      s = s.slice(2);
    } else if (s.startsWith("us") || s.startsWith("µs")) {
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

    // Go converts the fractional remainder via `uint64(float64(f) * (float64(unit)/scale))` —
    // a float64->uint64 conversion, which truncates toward zero, not rounds: `"0.5ns"` becomes
    // `0`, not `1`. `BigInt` division truncates toward zero unconditionally, so
    // `(frac * unitNs) / post` matches that exactly, without any intermediate float64 rounding.
    total += n * unitNs + (frac * unitNs) / post;
    if (total > MAX_INT64_NS) {
      throw new Error(`time: invalid duration "${orig}"`);
    }
  }

  return Number(neg ? -total : total);
}

/**
 * Port of Go `Duration.String()`. `0` formats as `"0s"`; otherwise only the
 * units needed to represent the value are shown, with minutes/seconds always
 * trailing an hours component (`"1h0m0s"`), and a sub-second remainder
 * formatted as a fraction of its largest applicable unit (`"1.5s"`,
 * `"300ms"`).
 */
export function legacyFormatGoDuration(nanoseconds: number): string {
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

/** Formats `totalNs / unitNs` with trailing zeros (and a trailing `.`) trimmed, matching Go's `fmtFrac`. */
function formatFraction(totalNs: number, unitNs: number): string {
  return (totalNs / unitNs).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

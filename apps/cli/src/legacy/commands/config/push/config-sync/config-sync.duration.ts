/**
 * Go `time.Duration` string formatting and parsing, parity with Go's
 * `src/time/time.go` `Duration.String()` and `time.ParseDuration()`.
 *
 * Duration is stored as nanoseconds (number). The formatter matches Go's output
 * exactly: "0s", "300ms", "5s", "1m0s", "1h0m0s", etc.
 */

/**
 * Port of Go `time.Duration.String()`.
 *
 * Rules (from `src/time/time.go`):
 *   - 0 → "0s"
 *   - Only show units that are non-zero, but minutes/seconds always appear
 *     together with hours when hours > 0: "1h0m0s".
 *   - Fractional seconds: "300ms", "1.5s".
 *   - Largest unit is hours.
 */
export function durationString(ns: number): string {
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
    // sub-second fraction?
    if (ms > 0 || us > 0 || ns > 0) {
      // Go formats as e.g. "1.5s"
      const total_ns = secs * 1_000_000_000 + ms * 1_000_000 + us * 1_000 + ns;
      const secFloat = total_ns / 1_000_000_000;
      // trim trailing zeros after decimal point
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

/** Nanoseconds per unit. */
const NS_PER_SECOND = 1_000_000_000;
const NS_PER_MINUTE = 60 * NS_PER_SECOND;
const NS_PER_HOUR = 60 * NS_PER_MINUTE;
const NS_PER_MS = 1_000_000;
const NS_PER_US = 1_000;

/**
 * Port of Go `time.ParseDuration`. Returns nanoseconds as a number.
 * Accepts: "5s", "1m0s", "24h0m0s", "300ms", "0s", "1.5s", etc.
 * Throws on invalid input.
 */
export function parseDuration(s: string): number {
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
      i++;
    }
    if (i < s.length && s.charAt(i) === ".") {
      i++;
      while (i < s.length && s.charAt(i) >= "0" && s.charAt(i) <= "9") {
        frac = frac * 10 + parseInt(s.charAt(i), 10);
        post *= 10;
        i++;
      }
    }
    s = s.slice(i);
    if (s.length === 0) throw new Error(`time: missing unit in duration "${orig}"`);

    // consume unit
    let unitNs: number;
    if (s.startsWith("ns")) {
      unitNs = 1;
      s = s.slice(2);
    } else if (s.startsWith("us") || s.startsWith("µs")) {
      // Both "us" and "µs" (U+00B5, the only micro sign Go accepts) are 2 JS
      // code units, so slice(2) advances past either.
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

    total += n * unitNs + Math.round((frac / post) * unitNs);
  }

  return neg ? -total : total;
}

/**
 * Convert seconds (integer from remote API) to a Go duration string.
 * Used for mfa.phone.max_frequency and sms.max_frequency and email.max_frequency.
 */
export function secondsToDurationString(secs: number): string {
  return durationString(secs * NS_PER_SECOND);
}

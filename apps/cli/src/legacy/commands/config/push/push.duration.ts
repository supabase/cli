/**
 * Duration-string parsing for `config push`.
 *
 * `supabase/config.toml` duration fields (`auth.sessions.timebox`,
 * `auth.sms.max_frequency`, …) share one text format with the platform's own
 * hosted duration settings: an optional leading `-`, then one or more
 * `<number><unit>` components in descending unit order (hours, minutes,
 * seconds, with an optional fractional remainder), e.g. `"0s"`, `"300ms"`,
 * `"5s"`, `"1m0s"`, `"1h0m0s"`. Durations are represented as nanoseconds
 * (a plain `number`) internally.
 */

const NS_PER_SECOND = 1_000_000_000;
const NS_PER_MINUTE = 60 * NS_PER_SECOND;
const NS_PER_HOUR = 60 * NS_PER_MINUTE;
const NS_PER_MS = 1_000_000;
const NS_PER_US = 1_000;

/**
 * Parses a duration string into nanoseconds.
 * Accepts: "5s", "1m0s", "24h0m0s", "300ms", "0s", "1.5s", etc.
 * Throws on invalid input.
 */
export function legacyParseDuration(s: string): number {
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
      // Both "us" and "µs" (U+00B5, the only micro sign accepted) are 2 JS
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

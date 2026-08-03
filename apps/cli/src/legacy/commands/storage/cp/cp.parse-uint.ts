/**
 * Faithful port of Go's `strconv.ParseUint(s, 0, 64)` — the exact parser pflag
 * runs for a `UintVarP` flag like `storage cp --jobs` (`uintValue.Set`,
 * `pflag/uint.go`). Operating on the RAW flag token (instead of a
 * pre-normalized number) is load-bearing for parity:
 *
 *  - every sign prefix is rejected, including `-0` and `+1` (a numeric
 *    normalization turns `-0` into negative zero, for which `value < 0` is
 *    false, silently accepting what Go rejects);
 *  - error messages carry the ORIGINAL spelling (`-01`, not `-1`);
 *  - base 0 enables Go's prefix/underscore forms: `0x10` → 16, `0o10`/`010` →
 *    8 (octal!), `0b10` → 2, and `1_0` → 10 — all of which Go accepts.
 *
 * All verdicts below are verified against go1.26 (`strconv.ParseUint(s, 0, 64)`):
 * `-0`/`-01`/`+1`/`3.5`/`abc`/`09`/`0x`/`_1`/`1_`/`1__0`/` 1` → invalid
 * syntax; `0x_10` → 16; `18446744073709551616` → value out of range.
 *
 * Go iterates bytes where this iterates UTF-16 code units, but every non-ASCII
 * unit (and every byte of a multibyte rune) falls outside the digit/letter
 * ranges in both, so the verdict is identical.
 *
 * Known residual: values above 2^53 lose precision in the `Number` conversion
 * (Go carries the exact uint64). They still PARSE identically; only the
 * resulting parallel-job count differs, in territory where Go's own behavior
 * (an `int` conversion of a near-2^64 uint) is already degenerate.
 */

const MAX_UINT64 = (1n << 64n) - 1n;

export type LegacyParseUintResult =
  | { readonly value: number }
  | { readonly cause: "invalid syntax" | "value out of range" };

export function legacyParseUintBase0(token: string): LegacyParseUintResult {
  if (token.length === 0) return { cause: "invalid syntax" };

  // Base detection for base 0 (`strconv/atoi.go`): `0x`/`0b`/`0o` prefixes
  // (only when at least one more character follows), else a leading `0` means
  // octal, else decimal. There is NO sign handling: `-`/`+` fall through to
  // the digit loop below and fail as non-digits, exactly like Go.
  let s = token;
  let base = 10n;
  if (s[0] === "0") {
    const marker = s.length >= 3 ? s[1]?.toLowerCase() : undefined;
    if (marker === "b") {
      base = 2n;
      s = s.slice(2);
    } else if (marker === "o") {
      base = 8n;
      s = s.slice(2);
    } else if (marker === "x") {
      base = 16n;
      s = s.slice(2);
    } else {
      base = 8n;
      s = s.slice(1);
    }
  }

  let sawUnderscore = false;
  let n = 0n;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let digit: bigint;
    if (code === 0x5f /* _ */) {
      // Only base 0 admits underscores; position rules are checked at the end.
      sawUnderscore = true;
      continue;
    } else if (code >= 0x30 && code <= 0x39) {
      digit = BigInt(code - 0x30);
    } else {
      const lower = code | 0x20;
      if (lower >= 0x61 && lower <= 0x7a) digit = BigInt(lower - 0x61 + 10);
      else return { cause: "invalid syntax" };
    }
    if (digit >= base) return { cause: "invalid syntax" };
    n = n * base + digit;
    if (n > MAX_UINT64) return { cause: "value out of range" };
  }
  if (sawUnderscore && !underscoreOk(token)) return { cause: "invalid syntax" };
  return { value: Number(n) };
}

/**
 * Go's `underscoreOK` (`strconv/atoi.go`): underscores must sit between
 * digits, or between the base prefix and the first digit (`0x_10` is valid).
 * The sign skip is unreachable through `legacyParseUintBase0` (a sign already
 * fails the digit loop) but is kept for fidelity to the Go source.
 */
function underscoreOk(token: string): boolean {
  // `saw` tracks the class of the previous character: `^` start-of-number,
  // `0` digit-or-prefix, `_` underscore, `!` anything else.
  let saw = "^";
  let s = token;
  if (s.length >= 1 && (s[0] === "-" || s[0] === "+")) s = s.slice(1);
  let i = 0;
  let hex = false;
  const marker = s[1]?.toLowerCase();
  if (s.length >= 2 && s[0] === "0" && (marker === "b" || marker === "o" || marker === "x")) {
    i = 2;
    saw = "0"; // the base prefix counts as a digit for separator purposes
    hex = marker === "x";
  }
  for (; i < s.length; i++) {
    const c = s[i] as string;
    if ((c >= "0" && c <= "9") || (hex && c.toLowerCase() >= "a" && c.toLowerCase() <= "f")) {
      saw = "0";
      continue;
    }
    if (c === "_") {
      if (saw !== "0") return false;
      saw = "_";
      continue;
    }
    if (saw === "_") return false;
    saw = "!";
  }
  return saw !== "_";
}

/**
 * Parses a numeric flag token the way `pflag`'s `uint64`/`int64` types do: base-0 prefixes
 * (`0x`, `0o`/leading `0`, `0b`), underscore digit separators, and strict int64/uint64 range
 * checks, rejecting any sign on an unsigned value (including `-0`, which a naive numeric parse
 * would treat as non-negative) and preserving the original token spelling. Used by shell
 * completion so candidate values are accepted/rejected the same way these flags always have.
 */

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_INT64 = (1n << 63n) - 1n;
// int64's negative bound has one more representable magnitude than the positive bound
// (two's complement): -9223372036854775808 is valid, but its positive magnitude,
// 9223372036854775808, is not.
const MAX_INT64_NEGATIVE_MAGNITUDE = 1n << 63n;

export type ParseUintResult =
  | { readonly value: number }
  | { readonly cause: "invalid syntax" | "value out of range" };

/**
 * Base-0 digit grammar shared by `parseUintBase0` (unsigned) and `isValidBase0Int64` (signed):
 * detects the base (`0x`/`0o`/`0b`, else leading `0` for octal, else decimal), accumulates
 * digits, and checks underscore placement. Bounds the magnitude at `MAX_UINT64` so the
 * range-check exit lives here once; `isValidBase0Int64` applies its own narrower int64 bound
 * afterward. `originalToken` keeps the sign (stripped from `token`) for the underscore check.
 */
function parseBase0Digits(
  token: string,
  originalToken: string,
): { readonly n: bigint } | { readonly cause: "invalid syntax" | "value out of range" } {
  if (token.length === 0) return { cause: "invalid syntax" };

  // Base detection: `0x`/`0b`/`0o` prefixes (only when at least one more character follows),
  // else a leading `0` means octal, else decimal.
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
  if (sawUnderscore && !underscoreOk(originalToken)) return { cause: "invalid syntax" };
  return { n };
}

export function parseUintBase0(token: string): ParseUintResult {
  const parsed = parseBase0Digits(token, token);
  // Magnitudes above 2^53 lose precision when converted to Number; only the accept/reject
  // verdict is guaranteed exact for values that large.
  return "cause" in parsed ? parsed : { value: Number(parsed.n) };
}

/**
 * Parses a numeric flag token as a signed base-0 int64, returning only the accept/reject
 * verdict (used by shell completion for e.g. `backups restore --timestamp`). Reuses
 * {@link parseBase0Digits} on the sign-stripped remainder, then bounds the magnitude against
 * int64's asymmetric two's-complement range: `-9223372036854775808` is valid, but that same
 * magnitude on the positive side, `9223372036854775808`, is one past int64 max.
 */
export function isValidBase0Int64(token: string): boolean {
  const isNegative = token[0] === "-";
  const unsigned = isNegative || token[0] === "+" ? token.slice(1) : token;
  const parsed = parseBase0Digits(unsigned, token);
  if ("cause" in parsed) return false;
  return parsed.n <= (isNegative ? MAX_INT64_NEGATIVE_MAGNITUDE : MAX_INT64);
}

/**
 * Underscores must sit between digits, or between the base prefix and the first digit
 * (`0x_10` is valid). Takes the original, possibly-signed token so `isValidBase0Int64`'s
 * leading sign doesn't throw off the prefix/digit boundary check; `parseUintBase0` never
 * reaches a sign here since one already fails the digit loop first.
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

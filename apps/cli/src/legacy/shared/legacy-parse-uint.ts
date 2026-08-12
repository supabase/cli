/**
 * Faithful port of Go's `strconv.ParseUint(s, 0, 64)` (`legacyParseUintBase0`)
 * and `strconv.ParseInt(s, 0, 64)` (`legacyIsValidBase0Int64`) — the exact
 * parsers pflag runs for `UintVarP`/`UintVar` and `Int64VarP`/`Int64Var`
 * flags respectively (`uintValue.Set`/`int64Value.Set`, `pflag/{uint,int64}.go`).
 * Hoisted here (from its original home under `commands/storage/cp/`, CLI-1965
 * review) once a second family needed it: `legacy-complete.ts` validates
 * `functions deploy --jobs`/`migration down --last`/`db reset --last` (uint) and
 * `backups restore --timestamp` (int64) — all declared `Flag.integer` in TS but
 * a Go pflag numeric type with a narrower, sign-and-range-sensitive parser —
 * the same way `storage cp --jobs` already does at parse time. Operating on
 * the RAW flag token (instead of a pre-normalized number) is load-bearing for
 * parity:
 *
 * - every sign prefix is rejected, including `-0` and `+1` (a numeric
 * normalization turns `-0` into negative zero, for which `value < 0` is
 * false, silently accepting what Go rejects);
 * - error messages carry the ORIGINAL spelling (`-01`, not `-1`);
 * - base 0 enables Go's prefix/underscore forms: `0x10` → 16, `0o10`/`010` →
 * 8 (octal!), `0b10` → 2, and `1_0` → 10 — all of which Go accepts.
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
const MAX_INT64 = (1n << 63n) - 1n;
// `strconv.ParseInt`'s negative bound has one MORE representable magnitude
// than the positive bound (two's complement) — `-9223372036854775808` is a
// valid `int64`, but `9223372036854775808` (its positive magnitude) is not.
const MAX_INT64_NEGATIVE_MAGNITUDE = 1n << 63n;

export type LegacyParseUintResult =
  | { readonly value: number }
  | { readonly cause: "invalid syntax" | "value out of range" };

/**
 * The base-0 digit grammar shared by `legacyParseUintBase0` (`ParseUint`,
 * unsigned) and `legacyIsValidBase0Int64` (`ParseInt`, signed) — base
 * detection (`0x`/`0o`/`0b` prefixes, else a leading `0` for octal, else
 * decimal), digit accumulation, and underscore placement, all per
 * `strconv/atoi.go`. Bounds the accumulated magnitude at `MAX_UINT64` — the
 * widest of the two callers' limits, and therefore a safe SUPERSET bound for
 * both (`MAX_INT64`/`MAX_INT64_NEGATIVE_MAGNITUDE` are both smaller): a
 * magnitude that already exceeds `MAX_UINT64` is "value out of range" for
 * either caller, so the exit can live here once. A value between the int64
 * bound and `MAX_UINT64` (this finding's own repro,
 * `9223372036854775808` — one past int64 max, comfortably under uint64 max)
 * parses successfully here and is bounded by `legacyIsValidBase0Int64`'s
 * OWN, narrower check afterward instead.
 *
 * `token` is the value with any sign prefix already stripped by the caller
 * (a sign character reaching this loop directly would fail as a non-digit,
 * exactly like Go's own digit loop) — `originalToken` (WITH the sign, when
 * the caller has one to give) is threaded through only for `underscoreOk`'s
 * separator check, which inspects the full original spelling.
 */
function legacyParseBase0Digits(
  token: string,
  originalToken: string,
): { readonly n: bigint } | { readonly cause: "invalid syntax" | "value out of range" } {
  if (token.length === 0) return { cause: "invalid syntax" };

  // Base detection for base 0 (`strconv/atoi.go`): `0x`/`0b`/`0o` prefixes
  // (only when at least one more character follows), else a leading `0` means
  // octal, else decimal.
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

export function legacyParseUintBase0(token: string): LegacyParseUintResult {
  const parsed = legacyParseBase0Digits(token, token);
  return "cause" in parsed ? parsed : { value: Number(parsed.n) };
}

/**
 * Faithful port of Go's `strconv.ParseInt(s, 0, 64)` — the exact parser
 * pflag runs for an `Int64VarP`/`Int64Var` flag (`int64Value.Set`,
 * `pflag/int64.go`), e.g. `backups restore --timestamp`
 * (`apps/cli-go/cmd/backups.go:43`, deleted in CLI-1970; last present at
 * commit 7b469f5b3). Only a syntax-and-range VERDICT is
 * needed for completion (not the parsed value), so this returns a boolean
 * rather than mirroring `LegacyParseUintResult`'s shape.
 *
 * Reuses {@link legacyParseBase0Digits} for the base/digit grammar (the
 * same one `legacyParseUintBase0` runs) on the sign-stripped remainder, then
 * applies `ParseInt`'s own two-step design: strip an optional leading
 * `+`/`-`, parse the magnitude, and bound it against `int64`'s asymmetric
 * two's-complement range — `-9223372036854775808` is valid, but that same
 * magnitude, `9223372036854775808`, is NOT (it is one past `int64`'s
 * positive bound, `9223372036854775807`) — verified empirically against a
 * real `apps/cli-go` build: `backups restore --timestamp
 * 9223372036854775808 --p` returns zero candidates with the Default
 * directive, while `--timestamp 9223372036854775807` (`int64` max) and
 * `--timestamp -9223372036854775808` (`int64` min) both still offer
 * `--profile`/`--project-ref` — CLI-1965 review finding.
 */
export function legacyIsValidBase0Int64(token: string): boolean {
  const isNegative = token[0] === "-";
  const unsigned = isNegative || token[0] === "+" ? token.slice(1) : token;
  const parsed = legacyParseBase0Digits(unsigned, token);
  if ("cause" in parsed) return false;
  return parsed.n <= (isNegative ? MAX_INT64_NEGATIVE_MAGNITUDE : MAX_INT64);
}

/**
 * `underscoreOK` (`strconv/atoi.go`): underscores must sit between
 * digits, or between the base prefix and the first digit (`0x_10` is valid).
 * The sign skip is unreachable through `legacyParseUintBase0` (a sign already
 * fails the digit loop before `underscoreOk` is ever reached) but IS reachable
 * through `legacyIsValidBase0Int64`, which passes the original, still-signed
 * token through for this check specifically (see that function's doc
 * comment) — kept unconditionally rather than split per-caller so both stay
 * governed by one port of Go's source.
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

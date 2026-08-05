import { legacyParseGoDuration } from "../../../shared/legacy-go-duration.ts";
import { legacyBearerJwtErrorMessage } from "./bearer-jwt.errors.ts";

// The fractional-seconds separator accepts EITHER `.` or `,` — Go's `time.Parse`
// (`time/format.go`'s `nextStdChunk`/digit-parsing loop) treats both as introducing a
// fractional second for any layout element, verified directly against the Go standard
// library: `time.Parse(time.RFC3339, "2030-01-01T00:00:00,5Z")` succeeds with the same
// nanosecond result as the `.5` spelling (CLI-1961 Codex review finding).
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * A Unix instant split into an exact whole-second floor and a non-negative
 * nanosecond remainder in `[0, 1e9)` — mirrors Go's own `time.Time` (a
 * whole-seconds field plus a separate nanoseconds field) instead of
 * collapsing both into a single `number`. A single float CANNOT hold both an
 * epoch-scale whole-second count (~2e9, already ~31 bits) and full
 * nanosecond precision (9 decimal digits) without silent rounding: verified
 * directly (CLI-1961 Codex review finding, `bearer-jwt.flags.ts:154`),
 * `1_893_456_000 + 0.999999999` rounds UP to the exact integer
 * `1_893_456_001` in plain JS float addition — a full second later than
 * Go's `jwt.NewNumericDate`, which truncates the real (nanosecond-preserving)
 * `time.Time` DOWN to `1_893_456_000`. Both fields here are plain safe
 * integers (`wholeSeconds` is many orders of magnitude below
 * `Number.MAX_SAFE_INTEGER`; `nanos` is always `< 1e9`), so every operation on
 * this type — see {@link legacyAddSecondsAndFloor} — is exact integer
 * arithmetic, never float rounding.
 */
export interface LegacyBearerJwtInstant {
  readonly wholeSeconds: number;
  readonly nanos: number;
}

const NANOS_PER_SECOND = 1_000_000_000;

/**
 * Adds a (possibly fractional, possibly negative) duration in seconds to an
 * exact {@link LegacyBearerJwtInstant} and returns the correctly-floored
 * whole-second result — mirrors Go's exact nanosecond-precision `time.Time`
 * arithmetic followed by `jwt.NewNumericDate`'s truncate-to-seconds
 * (`golang-jwt/jwt/v5`'s `types.go:38`), without ever adding an epoch-scale
 * whole-second count directly to a sub-second float (see
 * {@link LegacyBearerJwtInstant}'s own doc comment for why that rounds
 * incorrectly). `deltaSeconds` itself (`--valid-for`, parsed by
 * {@link legacyParseBearerJwtValidFor}) stays a plain float — its own
 * magnitude is never epoch-scale, so splitting it into whole/fractional parts
 * here is exact enough — only the addition against an epoch-scale instant
 * needs the exact-integer treatment.
 */
export function legacyAddSecondsAndFloor(
  instant: LegacyBearerJwtInstant,
  deltaSeconds: number,
): number {
  const deltaWhole = Math.floor(deltaSeconds);
  const deltaNanos = Math.round((deltaSeconds - deltaWhole) * NANOS_PER_SECOND);
  let wholeSeconds = instant.wholeSeconds + deltaWhole;
  let nanos = instant.nanos + deltaNanos;
  if (nanos < 0) {
    const borrow = Math.ceil(-nanos / NANOS_PER_SECOND);
    wholeSeconds -= borrow;
    nanos += borrow * NANOS_PER_SECOND;
  } else if (nanos >= NANOS_PER_SECOND) {
    const carry = Math.floor(nanos / NANOS_PER_SECOND);
    wholeSeconds += carry;
    nanos -= carry * NANOS_PER_SECOND;
  }
  return wholeSeconds;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
}

/**
 * Validates the calendar/clock components a syntactically-RFC3339 string decodes to,
 * matching Go's `time.Parse(time.RFC3339, ...)` — which, verified directly against
 * the Go standard library (CLI-1961), genuinely REJECTS an out-of-range month, day
 * (including per-month/leap-year day-of-month bounds), hour, minute, or second,
 * rather than normalizing them the way `time.Date`/JS's own `Date.parse` would (e.g.
 * `2030-02-30T...` silently rolling over to March 2nd). Go's `time.Parse` itself
 * raises a component-specific error (`"day out of range"`, etc.), but pflag's
 * `timeValue.Set` (`github.com/spf13/pflag@v1.0.10/time.go:24-44`) discards that text
 * entirely and falls through to the SAME generic wrapped message used for a
 * syntactically-malformed value — so this only needs a boolean, not Go's per-field
 * error text.
 */
function isValidRfc3339Calendar(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function rfc3339FlagError(trimmedValue: string): Error {
  return new Error(
    `invalid argument "${trimmedValue}" for "--exp" flag: invalid time format \`${trimmedValue}\` must be one of: \`2006-01-02T15:04:05Z07:00\``,
  );
}

/**
 * Go's `--exp` flag (`TimeVar(&expiry, "exp", time.Time{}, []string{time.RFC3339}, ...)`,
 * `apps/cli-go/cmd/gen.go:178`) calls `time.Parse(time.RFC3339, val)` inside pflag's
 * `Value.Set`, which runs during `cmd.ParseFlags` — BEFORE `RunE` (verified against the
 * real binary, CLI-1961). Behaviors verified directly against pflag's/Go's own source
 * rather than assumed:
 *   - `Value.Set` trims the input with `strings.TrimSpace` BEFORE ever calling
 *     `time.Parse`, so `--exp " 2030-01-01T00:00:00Z "` (surrounding whitespace)
 *     parses successfully — the trimmed value is used both for parsing and for the
 *     error message below (Go re-embeds ITS OWN already-trimmed `s`, never the
 *     original untrimmed argument).
 *   - A parse failure — whether syntactic, a Go-rejected out-of-range calendar
 *     component (`isValidRfc3339Calendar` above), or an out-of-range zone offset
 *     (below) — raises the exact same wrapped message: `invalid argument "<val>" for
 *     "--exp" flag: invalid time format \`<val>\` must be one of:
 *     \`2006-01-02T15:04:05Z07:00\`` (a single format, since `--exp` registers only
 *     RFC3339).
 *   - `time.Parse`'s own numeric zone-offset range check (`time/format.go:1267-1278`)
 *     rejects an offset hour/minute that OVERFLOWS a 2-digit field's max plausible
 *     value using `>` rather than `>=` ("as some people do write offsets of 24 hours
 *     or 60 minutes", per Go's own comment) — so `+24:00` parses successfully but
 *     `+99:99` (Codex review finding, CLI-1961) does not. Verified directly against
 *     the Go standard library. `Date.parse` cannot be reused for the final
 *     timestamp once an offset is present: it rejects `+24:00`/`+60`-minute offsets
 *     that Go accepts, and — more importantly — silently returns `NaN` for a
 *     genuinely-invalid offset like `+99:99` instead of throwing, which would let a
 *     malformed `--exp` mint a token with `exp`/`iat` claims that JSON-serialize as
 *     `null` (`JSON.stringify(NaN) === "null"`) rather than failing the command.
 *     Reimplements Go's `t.addSec(-zoneOffset)` (`format.go:1392`) directly instead:
 *     the local wall-clock components, interpreted as UTC, minus the signed offset
 *     in seconds.
 *   - Go's `time.Parse` accepts fractional seconds after the whole-seconds field EVEN
 *     THOUGH `time.RFC3339`'s own layout has no fractional-seconds directive — this is
 *     a documented parse-only extension ("in the absence of a fractional second in the
 *     format, the fractional part will still be parsed if it is present"), verified
 *     directly against the Go standard library. Extra digits beyond nanosecond (9-digit)
 *     precision are TRUNCATED, not rounded — verified directly against the Go standard
 *     library: `.9999999995` (10 digits) parses to nanosecond `999999999`, not a
 *     rounded-up `1000000000` that would carry into the next second. The parsed instant
 *     carries that fraction at full (nanosecond) precision into the `iat = exp -
 *     validFor` arithmetic in `legacyBuildBearerJwtClaims`, which floors only the FINAL
 *     `exp`/`iat` — so the fraction must survive this function's return value rather
 *     than being discarded here, matching `legacyParseBearerJwtValidFor`'s own
 *     no-early-flooring rule below. Verified against the real binary (CLI-1961):
 *     `--exp 2030-01-01T00:00:00.9Z --valid-for 1.2s` yields `iat=1893455999`, not the
 *     `1893455998` that dropping the `.9` fraction during parsing would produce.
 * Returns the parsed instant as an exact {@link LegacyBearerJwtInstant} — NOT a single
 * float — on success. See that type's own doc comment for why a single `number` cannot
 * hold both an epoch-scale whole-second count and nanosecond precision without silent
 * rounding (CLI-1961 Codex review finding, this file's own former line 154).
 */
export function legacyParseBearerJwtExp(value: string): LegacyBearerJwtInstant {
  const trimmedValue = value.trim();
  const match = RFC3339_PATTERN.exec(trimmedValue);
  if (match === null) {
    throw rfc3339FlagError(trimmedValue);
  }
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    isUtc,
    offsetSign,
    offsetHourStr,
    offsetMinuteStr,
  ] = match;
  if (
    !isValidRfc3339Calendar(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    )
  ) {
    throw rfc3339FlagError(trimmedValue);
  }

  let offsetSeconds = 0;
  if (isUtc === undefined) {
    const offsetHour = Number(offsetHourStr);
    const offsetMinute = Number(offsetMinuteStr);
    if (offsetHour > 24 || offsetMinute > 60) {
      throw rfc3339FlagError(trimmedValue);
    }
    offsetSeconds = (offsetHour * 60 + offsetMinute) * 60;
    if (offsetSign === "-") offsetSeconds = -offsetSeconds;
  }

  // `setUTCFullYear`/`setUTCHours` here, NOT `Date.UTC(...)`/`new Date(...)` — those
  // two apply JS's legacy two-digit-year remapping (`Date.UTC(1, 0, 1, ...)` silently
  // becomes 1901, not year 1) to any year in `[0, 99]`, which is a genuinely valid
  // 4-digit RFC3339 year Go's `time.Parse` accepts LITERALLY (verified against the Go
  // standard library: `0001-01-01T00:00:00Z` parses to Go year 1, Unix
  // `-62135596800`) — CLI-1961 Codex review finding. `Date.prototype.setUTCFullYear`
  // has no such special case at any year, per ECMA-262 (unlike the `Date.UTC`/`Date`
  // constructor forms), so building the instant via the epoch `Date` and setter calls
  // avoids the remapping entirely while still being exact (always a multiple of 1000,
  // since only whole-second components are passed in) — and `offsetSeconds` above is
  // always an exact integer number of seconds (a whole hour/minute offset), so
  // `wholeSeconds` needs no fractional handling at all. Only the fractional-second
  // digits themselves need a dedicated integer field: truncate (not round) to 9
  // digits, matching Go's own truncation of excess fractional digits verified above.
  const parsedDate = new Date(0);
  parsedDate.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  parsedDate.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const wholeSeconds = parsedDate.getTime() / 1000 - offsetSeconds;
  const nanos = fraction === undefined ? 0 : Number(fraction.slice(0, 9).padEnd(9, "0"));
  return { wholeSeconds, nanos };
}

/**
 * Go's `--valid-for` flag (`DurationVar(&validFor, "valid-for", time.Minute*30, ...)`,
 * `apps/cli-go/cmd/gen.go:179`) — same parse-time-failure shape as `--exp` above,
 * wrapping `legacyParseGoDuration`'s own Go-format `time: invalid duration "..."` text.
 * `time.Duration`'s own pflag `Value.Set` does NOT trim its input (unlike `--exp`'s
 * `timeValue.Set` above) — verified against pflag's source — so no `.trim()` here.
 *
 * Returns SECONDS WITHOUT FLOORING — Go computes `exp`/`iat` via exact-nanosecond
 * `time.Time` arithmetic on the parsed `time.Duration` and only floors the FINAL
 * timestamps (`jwt.NewNumericDate`'s `Truncate`, see `legacyBuildBearerJwtClaims`).
 * Flooring the duration itself here, before that arithmetic runs, would produce an
 * off-by-one-second result whenever the truncated fraction pushes the final sum/
 * difference across a second boundary — verified against the real binary (CLI-1961):
 * `--exp 2030-01-01T00:00:00Z --valid-for 1.5s` yields Go `iat=1893455998`, not the
 * `1893455999` a floor-first implementation would produce.
 */
export function legacyParseBearerJwtValidFor(value: string): number {
  try {
    return legacyParseGoDuration(value) / 1_000_000_000;
  } catch (cause) {
    throw new Error(
      `invalid argument "${value}" for "--valid-for" flag: ${legacyBearerJwtErrorMessage(cause)}`,
    );
  }
}

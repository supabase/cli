import { legacyParseGoDuration } from "../../../shared/legacy-go-duration.ts";
import { legacyBearerJwtErrorMessage } from "./bearer-jwt.errors.ts";

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

/**
 * Go's `--exp` flag (`TimeVar(&expiry, "exp", time.Time{}, []string{time.RFC3339}, ...)`,
 * `apps/cli-go/cmd/gen.go:178`) calls `time.Parse(time.RFC3339, val)` inside pflag's
 * `Value.Set`, which runs during `cmd.ParseFlags` — BEFORE `RunE` (verified against the
 * real binary, CLI-1961). Two behaviors verified directly against pflag's own source
 * (`time.go:24-44`) rather than assumed:
 *   - `Value.Set` trims the input with `strings.TrimSpace` BEFORE ever calling
 *     `time.Parse`, so `--exp " 2030-01-01T00:00:00Z "` (surrounding whitespace)
 *     parses successfully — the trimmed value is used both for parsing and for the
 *     error message below (Go re-embeds ITS OWN already-trimmed `s`, never the
 *     original untrimmed argument).
 *   - A parse failure — whether syntactic OR a Go-rejected out-of-range calendar
 *     component (`isValidRfc3339Calendar` above) — raises the exact same wrapped
 *     message: `invalid argument "<val>" for "--exp" flag: invalid time format
 *     \`<val>\` must be one of: \`2006-01-02T15:04:05Z07:00\`` (a single format,
 *     since `--exp` registers only RFC3339).
 * Returns Unix seconds on success.
 */
export function legacyParseBearerJwtExp(value: string): number {
  const trimmedValue = value.trim();
  const match = RFC3339_PATTERN.exec(trimmedValue);
  const isValid =
    match !== null &&
    isValidRfc3339Calendar(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
  if (!isValid) {
    throw new Error(
      `invalid argument "${trimmedValue}" for "--exp" flag: invalid time format \`${trimmedValue}\` must be one of: \`2006-01-02T15:04:05Z07:00\``,
    );
  }
  // Every component is now confirmed in range, so `Date.parse` can no longer silently
  // roll anything over — it's safe to reuse for the actual timestamp computation.
  return Math.floor(Date.parse(trimmedValue) / 1000);
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

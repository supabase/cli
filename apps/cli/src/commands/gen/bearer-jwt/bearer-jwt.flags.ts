import { parseGoDuration } from "../../../command-internal/go-duration.ts";
import { bearerJwtErrorMessage } from "./bearer-jwt.errors.ts";

// The fractional-seconds separator accepts either `.` or `,`, matching
// `time.Parse`'s RFC3339 handling for any layout element.
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * A Unix instant split into a whole-second floor and a nanosecond remainder
 * in `[0, 1e9)`, instead of one `number`.
 *
 * A single float can't hold an epoch-scale whole-second count together with
 * full nanosecond precision without silent rounding: `1_893_456_000 +
 * 0.999999999` rounds up to `1_893_456_001` in plain JS float addition, a
 * full second later than the correct floored value.
 */
export interface BearerJwtInstant {
  readonly wholeSeconds: number;
  readonly nanos: number;
}

const NANOS_PER_SECOND = 1_000_000_000;

/**
 * Adds a (possibly fractional, possibly negative) duration in seconds to an
 * exact {@link BearerJwtInstant} and returns the correctly-floored
 * whole-second result, without ever adding an epoch-scale whole-second count
 * directly to a sub-second float (see {@link BearerJwtInstant} for why that
 * rounds incorrectly).
 */
export function addSecondsAndFloor(instant: BearerJwtInstant, deltaSeconds: number): number {
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
 * Validates the calendar/clock components an RFC3339 string decodes to,
 * rejecting an out-of-range month, day, hour, minute, or second rather than
 * normalizing them the way JS's own `Date.parse` would (e.g. `2030-02-30`
 * silently rolling over to March 2nd). A boolean is enough since every
 * rejection reason maps to the same generic error message.
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
 * `--exp`, parsed the same way pflag's RFC3339 time flag does, at flag-parse
 * time. The input is trimmed before parsing and before it's re-embedded in
 * the error message. Any failure (syntax, an out-of-range calendar
 * component, or an out-of-range zone offset) raises the same wrapped
 * `invalid argument "<val>" for "--exp" flag: ...` message.
 *
 * The zone-offset range check accepts `+24:00`/60-minute offsets (`>`, not
 * `>=`) and rejects `+99:99` outright, unlike `Date.parse`, which returns
 * `NaN` for the latter — silently minting a token whose `exp`/`iat` claims
 * serialize as `null` instead of failing the command.
 *
 * Fractional seconds are accepted even though RFC3339 has no fractional
 * directive, truncated (not rounded) to 9 digits, and returned unfloored as
 * an exact {@link BearerJwtInstant} so `buildBearerJwtClaims` can floor only
 * the final `exp`/`iat`.
 */
export function parseBearerJwtExp(value: string): BearerJwtInstant {
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

  // `setUTCFullYear`/`setUTCHours`, not `Date.UTC`/`new Date(...)`: those remap
  // any two-digit year in `[0, 99]` (e.g. year 1 becomes 1901), but a valid
  // RFC3339 year in that range must be accepted literally. `setUTCFullYear`
  // has no such remapping, so building the instant this way avoids it.
  const parsedDate = new Date(0);
  parsedDate.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  parsedDate.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const wholeSeconds = parsedDate.getTime() / 1000 - offsetSeconds;
  const nanos = fraction === undefined ? 0 : Number(fraction.slice(0, 9).padEnd(9, "0"));
  return { wholeSeconds, nanos };
}

/**
 * `--valid-for`, parsed via {@link parseGoDuration} (Go duration syntax);
 * unlike `--exp`, this input is not trimmed.
 *
 * Returns seconds unfloored: `buildBearerJwtClaims` floors only the final
 * `exp`/`iat`, so flooring here first would produce an off-by-one-second
 * result whenever the truncated fraction crosses a second boundary.
 */
export function parseBearerJwtValidFor(value: string): number {
  try {
    return parseGoDuration(value) / 1_000_000_000;
  } catch (cause) {
    throw new Error(
      `invalid argument "${value}" for "--valid-for" flag: ${bearerJwtErrorMessage(cause)}`,
    );
  }
}

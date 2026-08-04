import { legacyParseGoDuration } from "../../../shared/legacy-go-duration.ts";
import { legacyBearerJwtErrorMessage } from "./bearer-jwt.errors.ts";

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Go's `--exp` flag (`TimeVar(&expiry, "exp", time.Time{}, []string{time.RFC3339}, ...)`,
 * `apps/cli-go/cmd/gen.go:178`) calls `time.Parse(time.RFC3339, val)` inside pflag's
 * `Value.Set`, which runs during `cmd.ParseFlags` — BEFORE `RunE` (verified against the
 * real binary, CLI-1961). A parse failure raises pflag's own wrapped message exactly:
 * `invalid argument "<val>" for "--exp" flag: invalid time format \`<val>\` must be one
 * of: \`2006-01-02T15:04:05Z07:00\`` (a single format, since `--exp` registers only
 * RFC3339). Returns Unix seconds on success.
 */
export function legacyParseBearerJwtExp(value: string): number {
  const parsed = RFC3339_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new Error(
      `invalid argument "${value}" for "--exp" flag: invalid time format \`${value}\` must be one of: \`2006-01-02T15:04:05Z07:00\``,
    );
  }
  return Math.floor(parsed / 1000);
}

/**
 * Go's `--valid-for` flag (`DurationVar(&validFor, "valid-for", time.Minute*30, ...)`,
 * `apps/cli-go/cmd/gen.go:179`) — same parse-time-failure shape as `--exp` above,
 * wrapping `legacyParseGoDuration`'s own Go-format `time: invalid duration "..."` text.
 * Returns whole seconds, truncated from the parsed nanoseconds — sub-second
 * `--valid-for` precision is not observable in the resulting `exp`/`iat` claims, which
 * are themselves truncated to the second (Go's `jwt.NewNumericDate` truncation).
 */
export function legacyParseBearerJwtValidFor(value: string): number {
  try {
    return Math.floor(legacyParseGoDuration(value) / 1_000_000_000);
  } catch (cause) {
    throw new Error(
      `invalid argument "${value}" for "--valid-for" flag: ${legacyBearerJwtErrorMessage(cause)}`,
    );
  }
}

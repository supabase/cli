import type { Cause } from "effect";
import {
  classifyCliCauseActionability,
  type CliErrorActionability,
} from "./error-actionability.ts";
import {
  PropErrorCategory,
  PropErrorFingerprint,
  PropErrorKind,
  PropHasSuggestion,
  PropSuggestedCommand,
  PropSuggestionType,
} from "./event-catalog.ts";

/** Projects the closed taxonomy contract onto the public telemetry schema. */
export function toFailureTelemetryProperties(
  classification: CliErrorActionability,
): Record<string, unknown> {
  const properties = {
    [PropErrorKind]: classification.error_kind,
    [PropErrorCategory]: classification.error_category,
    [PropErrorFingerprint]: classification.error_fingerprint,
    [PropHasSuggestion]: classification.has_suggestion,
    [PropSuggestionType]: classification.suggestion_type,
  };

  return classification.suggested_command === undefined
    ? properties
    : { ...properties, [PropSuggestedCommand]: classification.suggested_command };
}

export function failureTelemetryPropertiesForCause(
  cause: Cause.Cause<unknown>,
): Record<string, unknown> {
  return toFailureTelemetryProperties(classifyCliCauseActionability(cause));
}

import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyGenTypesNetworkError extends Data.TaggedError("LegacyGenTypesNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyGenTypesUnexpectedStatusError extends Data.TaggedError(
  "LegacyGenTypesUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyInvalidGenTypesDurationError extends Data.TaggedError(
  "LegacyInvalidGenTypesDurationError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A `postgrest-typegen` introspection query failed against a live database
 * the CLI successfully connected to. Schema-derived, so a database finding.
 */
export class LegacyGenTypesMetadataError extends Data.TaggedError("LegacyGenTypesMetadataError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * Language generation or formatting failed after introspection succeeded —
 * a CLI packaging / formatter / template defect, not a user schema finding.
 */
export class LegacyGenTypesGenerateError extends Data.TaggedError("LegacyGenTypesGenerateError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

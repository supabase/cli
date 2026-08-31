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
 * A `postgrest-typegen` introspection query or language generator failed
 * against a live database the CLI successfully connected to. Both stages
 * derive entirely from the user's schema contents, so they classify as a
 * database finding rather than a CLI defect.
 */
export class LegacyGenTypesMetadataError extends Data.TaggedError("LegacyGenTypesMetadataError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

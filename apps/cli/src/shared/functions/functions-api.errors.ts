import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../telemetry/error-actionability.ts";

/**
 * Shared error for a non-OK Management API response where an HTTP status
 * code is available, used by both `deploy.ts` and `download.ts`. Keeping one
 * class here (rather than duplicating it per file) lets both call sites
 * classify identically via {@link statusCodeActionability} instead of
 * falling back to a plain `Error` (which reports as `unknown` in the error
 * actionability KPI).
 */
export class FunctionsApiStatusError extends Data.TaggedError("FunctionsApiStatusError")<{
  readonly status: number;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Every construction site targets a functions endpoint keyed by a
    // user-supplied project ref / function slug, so a 404 means that ref/slug
    // did not match — user input, not an API failure.
    if (this.status === 404) {
      return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
    }
    return statusCodeActionability(this.status);
  }
}

/**
 * Shared error for a Management API request that failed before a response
 * was received (DNS, connection reset, timeout, ...), used by both
 * `deploy.ts` and `download.ts`'s `mapTransportError`. Keeping one class here
 * (rather than duplicating it per file) lets both call sites classify
 * identically as a network failure instead of falling back to a plain
 * `Error` (which reports as `unknown` in the error actionability KPI).
 */
export class FunctionsApiTransportError extends Data.TaggedError("FunctionsApiTransportError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
  }
}

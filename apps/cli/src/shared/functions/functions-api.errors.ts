import { Data } from "effect";
import {
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
    return statusCodeActionability(this.status);
  }
}

import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

export class ProjectRefNotLinkedError extends Data.TaggedError("ProjectRefNotLinkedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

export class InvalidProjectRefError extends Data.TaggedError("InvalidProjectRefError")<{
  readonly ref: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Raised by `resolveForLink` on a non-TTY when neither `--project-ref` nor
 * `SUPABASE_PROJECT_ID` is set. The message matches cobra's required-flag wording.
 */
export class ProjectRefRequiredError extends Data.TaggedError("ProjectRefRequiredError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.missingProjectRef;
  }
}

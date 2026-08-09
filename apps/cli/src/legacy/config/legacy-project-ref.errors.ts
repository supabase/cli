import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

export class LegacyProjectNotLinkedError extends Data.TaggedError("LegacyProjectNotLinkedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

export class LegacyInvalidProjectRefError extends Data.TaggedError("LegacyInvalidProjectRefError")<{
  readonly ref: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Raised by `resolveForLink` on a non-TTY when neither `--project-ref` nor
 * `SUPABASE_PROJECT_ID` is set. Byte-matches cobra's required-flag error string
 * (`required flag(s) "project-ref" not set`) that `supabase link`'s `PreRunE`
 * produces via `cmd.MarkFlagRequired("project-ref")`.
 */
export class LegacyProjectRefRequiredError extends Data.TaggedError(
  "LegacyProjectRefRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.missingProjectRef;
  }
}

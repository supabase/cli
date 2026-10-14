import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/** Seeding a project that matched a `[remotes.*]` block needs consent, and this run can't prompt for it. */
export class SeedConsentRequiredError extends Data.TaggedError("SeedConsentRequiredError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** A hosted mutation needs confirmation and this run can neither prompt nor see `--yes`. */
export class HostedMutationConsentRequiredError extends Data.TaggedError(
  "HostedMutationConsentRequiredError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.consentRequired;
  }
}

/** The user answered no to a hosted-mutation confirmation. */
export class HostedMutationDeclinedError extends Data.TaggedError("HostedMutationDeclinedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

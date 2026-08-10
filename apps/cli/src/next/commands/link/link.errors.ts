import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export class ProjectRefRequiredError extends Data.TaggedError("ProjectRefRequiredError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.missingProjectRef;
  }
}

export class NoAccessibleProjectsError extends Data.TaggedError("NoAccessibleProjectsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.accountAccess;
  }
}

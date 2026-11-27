import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export class SkillTopicNotFoundError extends Data.TaggedError("SkillTopicNotFoundError")<{
  readonly topic: string;
  readonly available: ReadonlyArray<string>;
  readonly version: string;
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SkillDisplayOutputFlagUnsupportedError extends Data.TaggedError(
  "SkillDisplayOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

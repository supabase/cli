import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/** The config document, project env files, or remote selection could not be loaded. */
export class CliConfigLoadError extends Data.TaggedError("CliConfigLoadError")<{
  readonly message: string;
  /** The `[remotes.<name>]` block the failure is about, when it is about one. */
  readonly remote?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

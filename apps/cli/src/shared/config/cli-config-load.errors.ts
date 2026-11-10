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
  /** The project env file, relative to the workdir, a read or parse failure is about. */
  readonly file?: string;
  readonly fileFailure?: "read" | "parse";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class InitParseSettingsError extends Data.TaggedError("InitParseSettingsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return "Failed to parse existing IDE settings file.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

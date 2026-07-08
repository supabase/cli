import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class InitAlreadyExistsError extends Data.TaggedError("InitAlreadyExistsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return "A Supabase project is already initialized in this directory.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class InitExperimentalRequiredError extends Data.TaggedError(
  "InitExperimentalRequiredError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return "The --use-orioledb flag requires --experimental.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

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

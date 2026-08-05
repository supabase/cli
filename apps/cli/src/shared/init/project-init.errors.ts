import { Data } from "effect";

export class InitParseSettingsError extends Data.TaggedError("InitParseSettingsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return "Failed to parse existing IDE settings file.";
  }
}

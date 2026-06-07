import { Data } from "effect";

export class UnsupportedLogsOutputFormatError extends Data.TaggedError(
  "UnsupportedLogsOutputFormatError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }
}

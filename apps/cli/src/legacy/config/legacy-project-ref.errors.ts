import { Data } from "effect";

export class LegacyProjectNotLinkedError extends Data.TaggedError("LegacyProjectNotLinkedError")<{
  readonly message: string;
}> {}

export class LegacyInvalidProjectRefError extends Data.TaggedError("LegacyInvalidProjectRefError")<{
  readonly ref: string;
  readonly message: string;
}> {}

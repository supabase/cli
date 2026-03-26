import { Data } from "effect";

export class PlatformInputError extends Data.TaggedError("PlatformInputError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {}

export class PlatformMetadataError extends Data.TaggedError("PlatformMetadataError")<{
  readonly message: string;
  readonly detail?: string;
}> {}

export class PlatformMethodNotFoundError extends Data.TaggedError("PlatformMethodNotFoundError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {}

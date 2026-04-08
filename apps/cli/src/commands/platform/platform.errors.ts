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

export class PlatformRouteNotFoundError extends Data.TaggedError("PlatformRouteNotFoundError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {}

export class PlatformMethodSelectionError extends Data.TaggedError("PlatformMethodSelectionError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {}

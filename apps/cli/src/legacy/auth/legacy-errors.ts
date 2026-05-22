import { Data } from "effect";

export class LegacyInvalidAccessTokenError extends Data.TaggedError(
  "LegacyInvalidAccessTokenError",
)<{
  readonly message: string;
}> {}

export class LegacyPlatformAuthRequiredError extends Data.TaggedError(
  "LegacyPlatformAuthRequiredError",
)<{
  readonly message: string;
}> {}

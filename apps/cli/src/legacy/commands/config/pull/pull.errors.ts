import { Data } from "effect";

export class LegacyConfigPullFileNotFoundError extends Data.TaggedError(
  "LegacyConfigPullFileNotFoundError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}

export class LegacyConfigPullTargetNotFoundError extends Data.TaggedError(
  "LegacyConfigPullTargetNotFoundError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}

export class LegacyConfigPullTargetEmptyError extends Data.TaggedError(
  "LegacyConfigPullTargetEmptyError",
)<{
  readonly message: string;
}> {}

export class LegacyConfigPullNetworkError extends Data.TaggedError("LegacyConfigPullNetworkError")<{
  readonly message: string;
}> {}

export class LegacyConfigPullStatusError extends Data.TaggedError("LegacyConfigPullStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

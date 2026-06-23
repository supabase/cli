import { Data } from "effect";

export class LegacyFunctionsListNetworkError extends Data.TaggedError(
  "LegacyFunctionsListNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyFunctionsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyFunctionsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyFunctionsEnvNotSupportedError extends Data.TaggedError(
  "LegacyFunctionsEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

import { Data } from "effect";

export class LegacyServicesEnvNotSupportedError extends Data.TaggedError(
  "LegacyServicesEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

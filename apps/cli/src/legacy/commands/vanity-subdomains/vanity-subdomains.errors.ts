import { Data } from "effect";

export class LegacyVanitySubdomainsGetNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsGetNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsCheckNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsCheckNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsCheckUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsCheckUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsActivateNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsActivateNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsActivateUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsActivateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsDeleteNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsDeleteNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyVanitySubdomainsDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

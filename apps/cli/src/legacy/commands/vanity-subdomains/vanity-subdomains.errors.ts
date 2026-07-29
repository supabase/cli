import { Data } from "effect";

/**
 * Raised by the `activate` and `check-availability` handlers when
 * `--desired-subdomain` is omitted. Go marks the flag required
 * (`cmd/vanitySubdomains.go:67,69`) but cobra validates required flags only
 * AFTER `PersistentPreRunE` (`cobra@v1.10.2/command.go:985,1005`) — i.e. after
 * the `--experimental` gate, login check, and project-ref resolution
 * (`cmd/root.go:93-117`) — so the flag is optional at parse time and enforced
 * in the handler instead. Byte-matches cobra's required-flag wording
 * (`command.go:1198`), same pattern as `LegacyProjectRefRequiredError`.
 */
export class LegacyDesiredSubdomainRequiredError extends Data.TaggedError(
  "LegacyDesiredSubdomainRequiredError",
)<{
  readonly message: string;
}> {}

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

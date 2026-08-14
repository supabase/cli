import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacyVanitySubdomainsGetNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsGetNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyVanitySubdomainsGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Unlike check/activate, non-gated 404s stay on the conservative
    // API-status policy rather than reading as invalid input.
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

export class LegacyVanitySubdomainsCheckNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsCheckNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyVanitySubdomainsCheckUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsCheckUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, {
      upgradeSuggested: this.upgradeSuggested,
      notFoundIsInvalidInput: true,
    });
  }
}

export class LegacyVanitySubdomainsActivateNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsActivateNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyVanitySubdomainsActivateUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsActivateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, {
      upgradeSuggested: this.upgradeSuggested,
      notFoundIsInvalidInput: true,
    });
  }
}

export class LegacyVanitySubdomainsDeleteNetworkError extends Data.TaggedError(
  "LegacyVanitySubdomainsDeleteNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyVanitySubdomainsDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyVanitySubdomainsDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

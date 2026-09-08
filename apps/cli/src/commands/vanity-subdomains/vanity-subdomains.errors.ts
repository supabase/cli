import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Raised by the `activate` and `check-availability` handlers when
 * `--desired-subdomain` is omitted. Go marks the flag required
 * (`cmd/vanitySubdomains.go:67,69`) but cobra validates required flags only
 * AFTER `PersistentPreRunE` (`cobra@v1.10.2/command.go:985,1005`) — i.e. after
 * the `--experimental` gate, login check, and project-ref resolution
 * (`cmd/root.go:93-117`) — so the flag is optional at parse time and enforced
 * in the handler instead. Byte-matches cobra's required-flag wording
 * (`command.go:1198`), same pattern as `ProjectRefRequiredError`.
 */
export class DesiredSubdomainRequiredError extends Data.TaggedError(
  "DesiredSubdomainRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class VanitySubdomainsGetNetworkError extends Data.TaggedError(
  "VanitySubdomainsGetNetworkError",
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

export class VanitySubdomainsGetUnexpectedStatusError extends Data.TaggedError(
  "VanitySubdomainsGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Unlike check/activate, this gated wrapper does not yet retain the typed
    // entitlement result. Keep 404 conservative rather than masking a plan gate.
    return statusCodeActionability(this.status);
  }
}

export class VanitySubdomainsCheckNetworkError extends Data.TaggedError(
  "VanitySubdomainsCheckNetworkError",
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

export class VanitySubdomainsCheckUnexpectedStatusError extends Data.TaggedError(
  "VanitySubdomainsCheckUnexpectedStatusError",
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

export class VanitySubdomainsActivateNetworkError extends Data.TaggedError(
  "VanitySubdomainsActivateNetworkError",
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

export class VanitySubdomainsActivateUnexpectedStatusError extends Data.TaggedError(
  "VanitySubdomainsActivateUnexpectedStatusError",
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

export class VanitySubdomainsDeleteNetworkError extends Data.TaggedError(
  "VanitySubdomainsDeleteNetworkError",
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

export class VanitySubdomainsDeleteUnexpectedStatusError extends Data.TaggedError(
  "VanitySubdomainsDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

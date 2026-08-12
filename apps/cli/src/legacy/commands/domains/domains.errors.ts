import { Data } from "effect";

import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Transport-level failure talking to the Management API custom-hostname
 * endpoints. Message format: `failed to <verb> custom hostname: <err>`.
 */
export class LegacyDomainsNetworkError extends Data.TaggedError("LegacyDomainsNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/**
 * The custom-hostname endpoint returned a status that is not treated as
 * success (201 for create/reverify/activate, 200 for get/delete). Message
 * format: `unexpected <verb> hostname status <code>: <body>`.
 */
export class LegacyDomainsUnexpectedStatusError extends Data.TaggedError(
  "LegacyDomainsUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The gated create/get/activate/reverify wrappers currently do not retain
    // the entitlement check's boolean on this shared error. Keep 404 on the
    // conservative API-status policy until that typed signal is threaded.
    return statusCodeActionability(this.status);
  }
}

/**
 * The CNAME pre-check in `domains create` failed — either the DNS lookup did
 * not resolve to a CNAME, or it resolved to a host other than the expected
 * Supabase subdomain.
 */
export class LegacyDomainsCnameError extends Data.TaggedError("LegacyDomainsCnameError")<{
  readonly message: string;
  /**
   * Set when the DNS-over-HTTPS resolver call itself failed (timeout,
   * non-200, or fetch failure against the 1.1.1.1 resolver) rather than the
   * CNAME being missing or pointing at the wrong host.
   */
  readonly transport?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.transport === true) {
      return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
    }
    return actionability.invalidConfig;
  }
}

/**
 * Build the network/status error mapper for a custom-hostname subcommand. The
 * error strings differ only by verb, so each handler supplies its verb and
 * shares the dispatch + body-truncation policy from `mapLegacyHttpError`.
 *
 * @param verb - the established phrasing, e.g. `"create"`, `"get"`, `"re-verify"`.
 */
export function mapLegacyDomainsHttpError(verb: string) {
  return mapLegacyHttpError({
    networkError: LegacyDomainsNetworkError,
    statusError: LegacyDomainsUnexpectedStatusError,
    networkMessage: (cause) => `failed to ${verb} custom hostname: ${cause}`,
    statusMessage: (status, body) => `unexpected ${verb} hostname status ${status}: ${body}`,
  });
}

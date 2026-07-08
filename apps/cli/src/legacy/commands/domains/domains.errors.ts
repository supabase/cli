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
 * endpoints. Mirrors Go's `errors.Errorf("failed to <verb> custom hostname: %w", err)`
 * (`apps/cli-go/internal/hostnames/*`).
 */
export class LegacyDomainsNetworkError extends Data.TaggedError("LegacyDomainsNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/**
 * The custom-hostname endpoint returned a status the Go CLI does not treat as
 * success (201 for create/reverify/activate, 200 for get/delete). Mirrors Go's
 * `errors.Errorf("unexpected <verb> hostname status %d: %s", code, body)`.
 */
export class LegacyDomainsUnexpectedStatusError extends Data.TaggedError(
  "LegacyDomainsUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

/**
 * The CNAME pre-check in `domains create` failed — either the DNS lookup did
 * not resolve to a CNAME, or it resolved to a host other than the expected
 * Supabase subdomain. Mirrors `apps/cli-go/internal/hostnames/common.go:14-22`.
 */
export class LegacyDomainsCnameError extends Data.TaggedError("LegacyDomainsCnameError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Build the network/status error mapper for a custom-hostname subcommand. The
 * Go error strings differ only by verb, so each handler supplies its verb and
 * shares the dispatch + body-truncation policy from `mapLegacyHttpError`.
 *
 * @param verb - the Go phrasing, e.g. `"create"`, `"get"`, `"re-verify"`.
 */
export function mapLegacyDomainsHttpError(verb: string) {
  return mapLegacyHttpError({
    networkError: LegacyDomainsNetworkError,
    statusError: LegacyDomainsUnexpectedStatusError,
    networkMessage: (cause) => `failed to ${verb} custom hostname: ${cause}`,
    statusMessage: (status, body) => `unexpected ${verb} hostname status ${status}: ${body}`,
  });
}

import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";
import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";

/**
 * Transport-level failure talking to the Management API pgsodium endpoints.
 * Message format: `failed to <verb> pgsodium config: <err>`.
 */
export class LegacyEncryptionNetworkError extends Data.TaggedError("LegacyEncryptionNetworkError")<{
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
 * The pgsodium endpoint returned a status that is not treated as success
 * (only `JSON200` is accepted). Message format:
 * `unexpected <verb> pgsodium config status <code>: <body>`.
 */
export class LegacyEncryptionUnexpectedStatusError extends Data.TaggedError(
  "LegacyEncryptionUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * Build the network/status error mapper for an encryption subcommand. Go uses
 * different verbs for the network vs status message of the same subcommand
 * (get: "retrieve"/"get"; update: "update"/"update"), so the factory takes
 * both and shares the dispatch + body-truncation policy from `mapLegacyHttpError`.
 */
export function mapLegacyEncryptionHttpError(verbs: {
  readonly networkVerb: string; // "retrieve" | "update"
  readonly statusVerb: string; // "get" | "update"
}) {
  return mapLegacyHttpError({
    networkError: LegacyEncryptionNetworkError,
    statusError: LegacyEncryptionUnexpectedStatusError,
    networkMessage: (cause) => `failed to ${verbs.networkVerb} pgsodium config: ${cause}`,
    statusMessage: (status, body) =>
      `unexpected ${verbs.statusVerb} pgsodium config status ${status}: ${body}`,
  });
}

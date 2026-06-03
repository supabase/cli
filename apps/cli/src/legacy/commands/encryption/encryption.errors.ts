import { Data } from "effect";

import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";

/**
 * Transport-level failure talking to the Management API pgsodium endpoints.
 * Mirrors Go's `errors.Errorf("failed to <verb> pgsodium config: %w", err)`
 * (`apps/cli-go/internal/encryption/{get,update}`).
 */
class LegacyEncryptionNetworkError extends Data.TaggedError("LegacyEncryptionNetworkError")<{
  readonly message: string;
}> {}

/**
 * The pgsodium endpoint returned a status the Go CLI does not treat as success
 * (it only accepts `JSON200`). Mirrors Go's
 * `errors.Errorf("unexpected <verb> pgsodium config status %d: %s", code, body)`.
 */
class LegacyEncryptionUnexpectedStatusError extends Data.TaggedError(
  "LegacyEncryptionUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

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

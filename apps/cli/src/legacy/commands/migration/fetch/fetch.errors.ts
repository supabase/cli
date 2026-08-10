import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Writing a fetched migration file failed. Byte-matches Go's
 * `failed to write migration: %w` (`internal/migration/fetch/fetch.go:38`).
 */
export class LegacyMigrationFetchWriteError extends Data.TaggedError(
  "LegacyMigrationFetchWriteError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

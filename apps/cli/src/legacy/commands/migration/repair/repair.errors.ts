import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Applying the repair batch (TRUNCATE / UPSERT / DELETE) failed. Matches the
 * established `failed to update migration table: %w` text.
 */
export class LegacyMigrationRepairUpdateError extends Data.TaggedError(
  "LegacyMigrationRepairUpdateError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

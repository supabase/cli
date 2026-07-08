import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Applying the repair batch (TRUNCATE / UPSERT / DELETE) failed. Byte-matches
 * Go's `failed to update migration table: %w`
 * (`internal/migration/repair/repair.go:80`).
 */
export class LegacyMigrationRepairUpdateError extends Data.TaggedError(
  "LegacyMigrationRepairUpdateError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

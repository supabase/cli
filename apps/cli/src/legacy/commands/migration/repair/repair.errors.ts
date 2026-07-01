import { Data } from "effect";

/**
 * Applying the repair batch (TRUNCATE / UPSERT / DELETE) failed. Byte-matches
 * Go's `failed to update migration table: %w`
 * (`internal/migration/repair/repair.go:80`).
 */
export class LegacyMigrationRepairUpdateError extends Data.TaggedError(
  "LegacyMigrationRepairUpdateError",
)<{
  readonly message: string;
}> {}

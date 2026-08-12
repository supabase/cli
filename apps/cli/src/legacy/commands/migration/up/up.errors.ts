import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * A remote migration version is not present in the local migrations directory.
 * The `migration repair --status reverted ...` suggestion is attached separately.
 */
export class LegacyMigrationMissingLocalError extends Data.TaggedError(
  "LegacyMigrationMissingLocalError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

/**
 * Out-of-order local migrations exist before the last remote migration, and
 * `--include-all` was not set. The `--include-all` suggestion is attached
 * separately.
 */
export class LegacyMigrationMissingRemoteError extends Data.TaggedError(
  "LegacyMigrationMissingRemoteError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

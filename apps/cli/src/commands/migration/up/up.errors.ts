import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * A remote migration version is not present in the local migrations directory.
 * The `migration repair --status reverted ...` suggestion is attached separately.
 */
export class MigrationMissingLocalError extends Data.TaggedError("MigrationMissingLocalError")<{
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
export class MigrationMissingRemoteError extends Data.TaggedError("MigrationMissingRemoteError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

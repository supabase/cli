import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Creating the migrations directory or writing the new migration file failed.
 * Wraps the established `failed to open migration file` / mkdir errors.
 */
export class LegacyMigrationNewWriteError extends Data.TaggedError("LegacyMigrationNewWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

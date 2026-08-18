import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/** `--last 0`. Matches the established `--last must be greater than 0` text. */
export class LegacyMigrationLastZeroError extends Data.TaggedError("LegacyMigrationLastZeroError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--last` >= the number of applied migrations. Matches the established
 * `--last must be smaller than total applied migrations: <total>` text;
 * the `supabase db reset` suggestion is attached separately.
 */
export class LegacyMigrationLastTooLargeError extends Data.TaggedError(
  "LegacyMigrationLastTooLargeError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

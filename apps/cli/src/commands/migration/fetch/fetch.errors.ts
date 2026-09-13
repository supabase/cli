import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Writing a fetched migration file failed. Matches the established
 * `failed to write migration: %w` text.
 */
export class MigrationFetchWriteError extends Data.TaggedError("MigrationFetchWriteError")<{
  readonly message: string;
  /**
   * Absolute paths of migration files already written before this failure, in
   * remote-history order; omitted if nothing had been written yet. Read by
   * `pull.aggregate.ts` to report partial progress instead of an empty list.
   */
  readonly writtenSoFar?: ReadonlyArray<string>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

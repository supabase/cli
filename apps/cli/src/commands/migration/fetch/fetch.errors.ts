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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

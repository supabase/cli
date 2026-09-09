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
   * Absolute paths of migration files this fetch had already written, in remote-history
   * order, before THIS failure — populated whenever a later row in the same fetch fails
   * validation or the write itself (a tampered/malformed remote row, or a mid-loop write
   * failure), after earlier rows already wrote successfully. `undefined`/omitted when
   * nothing had been written yet (e.g. the very first row failed, or the failure happened
   * before the write loop even started). Read by `pull.aggregate.ts`'s
   * `pullFailedStepResult` (via `hasWrittenSoFar`) so `supabase pull`'s
   * `migration_history` step can report partial progress instead of always claiming
   * `written: []` on a failed fetch.
   */
  readonly writtenSoFar?: ReadonlyArray<string>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

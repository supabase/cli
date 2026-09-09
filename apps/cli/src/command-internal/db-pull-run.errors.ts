import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * The remote migration history does not match local files; message text is
 * an established output contract. The actionable `supabase migration repair`
 * suggestion is attached separately.
 */
export class DbPullMigrationConflictError extends Data.TaggedError("DbPullMigrationConflictError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

/**
 * The diff produced no schema changes; message text is an established output
 * contract. This surfaces as a (non-zero exit) error rather than a success,
 * unlike `db diff` which prints it and exits 0.
 */
export class DbPullInSyncError extends Data.TaggedError("DbPullInSyncError")<{
  readonly message: string;
  /**
   * Explains the non-zero exit instead of letting `Output.fail` append the
   * generic "Try rerunning the command with --debug" footer — an in-sync
   * database is a finding, not a failure to troubleshoot. The message and exit
   * code stay Go-identical; only the footer diverges (see
   * `docs/go-cli-divergences.md`).
   */
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

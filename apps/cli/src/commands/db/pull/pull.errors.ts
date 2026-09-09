import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags (`db-url`/`linked`/`local`); message text
 * is an established output contract.
 */
export class DbPullTargetFlagsError extends Data.TaggedError("DbPullTargetFlagsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--declarative` / `--use-pg-delta` combined with `--diff-engine`; message
 * text is an established output contract.
 */
export class DbPullEngineConflictError extends Data.TaggedError("DbPullEngineConflictError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Writing the migration file / updating the remote migration-history table failed.
 */
export class DbPullWriteError extends Data.TaggedError("DbPullWriteError")<{
  readonly message: string;
  /**
   * Absolute path(s) of migration file(s) `runDbPull` had already written to disk
   * before THIS failure — populated when the remote migration-history update
   * (`updateMigrationHistory`, the "Update remote migration history table?" step)
   * fails AFTER the migration file write it's meant to record already succeeded.
   * `undefined`/omitted for every other `DbPullWriteError` (a failed file write
   * itself never reaches this field, since nothing new was written in that case).
   * Read by `pull.aggregate.ts`'s `pullFailedStepResult` (via `hasWrittenSoFar`) so
   * `supabase pull`'s `db` step can report the on-disk migration instead of always
   * claiming `written: []` on a failed pull.
   */
  readonly writtenSoFar?: ReadonlyArray<string>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * The initial-pull pg_dump container exited non-zero; message text is an
 * established output contract (`"error running container: exit " + code`).
 * Carries the same optional IPv6 transaction-pooler hint the dump path
 * attaches, which `Output.fail` prints bare on stderr after the message.
 */
export class DbPullDumpError extends Data.TaggedError("DbPullDumpError")<{
  readonly message: string;
  readonly suggestion?: string;
  /**
   * Set when the failure is opening/truncating the local migration file before
   * any pg_dump attempt — a filesystem permission problem, not a database
   * connection failure. The actual pg_dump-run failures leave it unset and keep
   * the `dbConnection` classification.
   */
  readonly fileOpen?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.fileOpen === true
      ? { ...actionability.permission, fingerprint_suffix: "filesystem" }
      : { ...actionability.dbConnection, fingerprint_suffix: "connect" };
  }
}

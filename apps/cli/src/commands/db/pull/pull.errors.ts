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
   * Absolute path(s) already written to disk before this failure — set when the remote
   * migration-history update fails after the migration file write it's meant to record
   * already succeeded. Read by `pull.aggregate.ts`'s `pullFailedStepResult` so a failed
   * pull can still report the on-disk migration instead of `written: []`.
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
   * Set when the failure is opening/truncating the local migration file before any
   * pg_dump attempt (a filesystem problem, not a connection failure); pg_dump-run
   * failures leave it unset and keep the `dbConnection` classification.
   */
  readonly fileOpen?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.fileOpen === true
      ? { ...actionability.permission, fingerprint_suffix: "filesystem" }
      : { ...actionability.dbConnection, fingerprint_suffix: "connect" };
  }
}

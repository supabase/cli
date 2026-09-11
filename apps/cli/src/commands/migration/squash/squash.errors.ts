import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * `squashToVersion` found no local migrations to squash — either the migrations
 * directory is empty, or `--version` filtered out every file. Matches the
 * established `"version not found"` text.
 */
export class MigrationSquashMissingVersionError extends Data.TaggedError(
  "MigrationSquashMissingVersionError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * One of squash's three `pg_dump` runs exited non-zero. Container dumps keep
 * `"error running container: exit " + code`; native PATH dumps use
 * `"error running pg_dump: exit " + code`.
 */
export class MigrationSquashDumpError extends Data.TaggedError("MigrationSquashDumpError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * The target migration file could not be truncated/opened for writing, or a chunk
 * of the full dump/separator/diff could not be appended to it. Matches the
 * established `"failed to open migration file: " + err` / `"failed to write
 * line: " + err` text.
 */
export class MigrationSquashWriteError extends Data.TaggedError("MigrationSquashWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * `baselineMigrations`'s history-table batch (`DELETE_MIGRATION_BEFORE` +
 * `INSERT_MIGRATION_VERSION`) failed to send/commit. Matches the established
 * `"failed to update migration history: " + err` text, classified `dbConnection`
 * like `migration repair`'s `MigrationRepairUpdateError` for the same failure shape.
 */
export class MigrationSquashBaselineError extends Data.TaggedError("MigrationSquashBaselineError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

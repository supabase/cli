import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * `squashToVersion` found no local migrations to squash — either the migrations
 * directory is empty, or `--version` filtered out every file. Matches the
 * established `"version not found"` text.
 */
export class LegacyMigrationSquashMissingVersionError extends Data.TaggedError(
  "LegacyMigrationSquashMissingVersionError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * One of squash's three `pg_dump` containers exited non-zero. Matches the
 * established `"error running container: exit " + code` text.
 */
export class LegacyMigrationSquashDumpError extends Data.TaggedError(
  "LegacyMigrationSquashDumpError",
)<{
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
export class LegacyMigrationSquashWriteError extends Data.TaggedError(
  "LegacyMigrationSquashWriteError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * `baselineMigrations`'s history-table batch (`LEGACY_DELETE_MIGRATION_BEFORE` +
 * `INSERT_MIGRATION_VERSION`) failed to send/commit. Matches the established
 * `"failed to update migration history: " + err` text. Classified `dbConnection`,
 * matching `migration repair`'s `LegacyMigrationRepairUpdateError`
 * (`repair.errors.ts:19`) — both wrap the identical history-table batch-send
 * failure shape.
 */
export class LegacyMigrationSquashBaselineError extends Data.TaggedError(
  "LegacyMigrationSquashBaselineError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

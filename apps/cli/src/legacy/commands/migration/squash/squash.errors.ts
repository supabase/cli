import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * `squashToVersion` found no local migrations to squash — either the migrations
 * directory is empty, or `--version` filtered out every file. Byte-matches Go's
 * `ErrMissingVersion` (`squash.go:26`, `errors.New("version not found")`).
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
 * One of squash's three `pg_dump` containers exited non-zero. Byte-matches Go's
 * `"error running container: exit " + code` (`DockerStreamLogs`, reached via
 * `migration.DumpSchema` -> `dump.DockerExec`).
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
 * of the full dump/separator/diff could not be appended to it. Byte-matches Go's
 * `"failed to open migration file: " + err` (`squash.go:123`) / `"failed to write
 * line: " + err` (`squash.go:153`).
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
 * `INSERT_MIGRATION_VERSION`) failed to send/commit. Byte-matches Go's `"failed to
 * update migration history: " + err` (`squash.go:187`). Classified `dbConnection`,
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

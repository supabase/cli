import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` error byte-for-byte
 * (`apps/cli-go/cmd/migration.go`, deleted in CLI-1970; last present at commit
 * 7b469f5b3). Shared by list / fetch / repair / up / down /
 * squash.
 */
export class LegacyMigrationTargetFlagsError extends Data.TaggedError(
  "LegacyMigrationTargetFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--db-url` combined with `--password`/`-p`. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("db-url", "password")` (list / repair / squash).
 */
export class LegacyMigrationPasswordFlagsError extends Data.TaggedError(
  "LegacyMigrationPasswordFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A positional version argument is not a valid integer. Byte-matches Go's
 * `failed to parse <v>: invalid version number` (`repair.go:27`, `ErrInvalidVersion`).
 */
export class LegacyMigrationInvalidVersionError extends Data.TaggedError(
  "LegacyMigrationInvalidVersionError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * No local migration file matched the requested version glob. Byte-matches Go's
 * `glob supabase/migrations/<version>_*.sql: file does not exist`
 * (`repair.GetMigrationFile`). Shared by repair (applied) and squash.
 */
export class LegacyMigrationFileNotFoundError extends Data.TaggedError(
  "LegacyMigrationFileNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The user declined a confirmation prompt (overwrite / repair-all / revert).
 * Mirrors Go returning `context.Canceled`, which the root maps to a non-zero exit
 * with no extra output.
 */
export class LegacyOperationCanceledError extends Data.TaggedError("LegacyOperationCanceledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

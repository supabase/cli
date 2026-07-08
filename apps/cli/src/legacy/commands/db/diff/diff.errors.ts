import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` `ValidateFlagGroups`
 * error byte-for-byte (`apps/cli-go/cmd/db.go:423`).
 */
export class LegacyDbDiffTargetFlagsError extends Data.TaggedError("LegacyDbDiffTargetFlagsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Conflicting diff-engine flags. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("use-migra", "use-pgadmin", "use-pg-schema", "use-pg-delta")`
 * error byte-for-byte (`apps/cli-go/cmd/db.go:416`).
 */
export class LegacyDbDiffEngineConflictError extends Data.TaggedError(
  "LegacyDbDiffEngineConflictError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Only one of `--from` / `--to` was set in explicit diff mode. Byte-matches Go's
 * `"must set both --from and --to when using explicit diff mode"`
 * (`apps/cli-go/cmd/db.go:105`).
 */
export class LegacyDbDiffExplicitFlagsError extends Data.TaggedError(
  "LegacyDbDiffExplicitFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * An explicit `--from`/`--to` ref was neither `local`/`linked`/`migrations` nor a
 * postgres URL. Byte-matches Go's `resolveExplicitDatabaseRef`
 * `"unknown target %q: must be one of 'local', 'linked', 'migrations', or a postgres:// URL"`
 * (`apps/cli-go/internal/db/diff/explicit.go:44`).
 */
export class LegacyDbDiffUnknownTargetError extends Data.TaggedError(
  "LegacyDbDiffUnknownTargetError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Writing the diff output failed — a `--file` migration, or an explicit-mode
 * `--output` file. Wraps Go's `utils.WriteFile` failure (`internal/utils/misc.go`).
 */
export class LegacyDbDiffWriteError extends Data.TaggedError("LegacyDbDiffWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

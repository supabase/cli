import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../../shared/telemetry/error-actionability.ts";

/**
 * Declarative commands were invoked without `--experimental` and without
 * `[experimental.pgdelta] enabled = true`. Byte-matches Go's gate error
 * `"declarative commands require --experimental flag or pg-delta enabled in config"`
 * plus the `utils.CmdSuggestion`
 * (`apps/cli-go/cmd/db_schema_declarative.go:63-69`).
 */
export class LegacyDeclarativeNotEnabledError extends Data.TaggedError(
  "LegacyDeclarativeNotEnabledError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A target could not be resolved in non-interactive mode. Byte-matches Go's
 * `"in non-interactive mode, specify a target: --local, --linked, or --db-url"`
 * (generate, `:200`) and the sync variants that require `db schema declarative
 * generate` first (`:311`, `:318`).
 */
export class LegacyDeclarativeNonInteractiveError extends Data.TaggedError(
  "LegacyDeclarativeNonInteractiveError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A mutually-exclusive flag group was violated. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive` `ValidateFlagGroups` error byte-for-byte:
 *  - `generate`: `db-url`/`linked`/`local` (`apps/cli-go/cmd/db_schema_declarative.go:570`)
 *  - `sync`: `apply`/`no-apply` (`apps/cli-go/cmd/db_schema_declarative.go:561`)
 * Both fail before any side effects run, matching cobra's pre-RunE validation.
 */
export class LegacyDeclarativeMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDeclarativeMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The interactive custom-database-URL prompt was empty or unparseable. Byte-matches
 * Go's `"database URL cannot be empty"` (`:281`) and
 * `"failed to parse connection string: " + err` (`:285`).
 */
export class LegacyDeclarativeInvalidDbUrlError extends Data.TaggedError(
  "LegacyDeclarativeInvalidDbUrlError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `db schema declarative generate` ran but produced no declarative files (sync's
 * post-generate guard). Byte-matches Go's
 * `"declarative schema generation did not produce any files"` (`:326`).
 */
export class LegacyDeclarativeNoFilesGeneratedError extends Data.TaggedError(
  "LegacyDeclarativeNoFilesGeneratedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * Diffing declarative schema to migrations failed. Wraps
 * `declarative.DiffDeclarativeToMigrations` errors
 * (`apps/cli-go/internal/db/declarative/declarative.go`). A debug bundle is
 * written before this surfaces.
 */
export class LegacyDeclarativeDiffError extends Data.TaggedError("LegacyDeclarativeDiffError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** Sync stopped because a manifest-less legacy schema needs an explicit migration choice. */
export class LegacyDeclarativeCompatibilityError extends Data.TaggedError(
  "LegacyDeclarativeCompatibilityError",
)<{
  readonly message: string;
}> {}

/**
 * Applying the generated migration to the local database failed. Wraps Go's
 * `applyMigrationToLocal` error; in interactive mode the handler offers a
 * reset+reapply before this surfaces
 * (`apps/cli-go/cmd/db_schema_declarative.go:397-435`).
 */
export class LegacyDeclarativeApplyError extends Data.TaggedError("LegacyDeclarativeApplyError")<{
  readonly message: string;
  /**
   * Set when this failure came from connecting to the local Postgres instance
   * (`dbConnection.connect`) rather than the migration SQL failing to apply.
   */
  readonly connect?: boolean;
  /**
   * Forwarded from the underlying typed failure this wraps (e.g. a
   * `LegacyKongReloadError`'s recovery hint, or a health-timeout architecture
   * hint) when the local-reset recovery path fails — the wrap must not drop it
   * (review CLI-1958).
   */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.connect === true) {
      return { ...actionability.dbConnection, fingerprint_suffix: "connect" };
    }
    return actionability.dbFinding;
  }
}

/**
 * Duck-types an optional `suggestion: string` off an arbitrary typed failure —
 * used when wrapping a lower-level error (e.g. `legacyResetLocalDatabase`'s
 * `LegacyKongReloadError`) into a {@link LegacyDeclarativeApplyError} so its
 * recovery hint isn't silently dropped by the wrap.
 */
export function legacyReadErrorSuggestion(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("suggestion" in error)) return undefined;
  const { suggestion } = error as { suggestion: unknown };
  return typeof suggestion === "string" ? suggestion : undefined;
}

/**
 * Materializing the declarative export on disk failed. Byte-matches Go's
 * `WriteDeclarativeSchemas` errors (`declarative.go:239`):
 * `"failed to clean declarative schema directory: " + err` and
 * `"unsafe declarative export path: " + path`.
 */

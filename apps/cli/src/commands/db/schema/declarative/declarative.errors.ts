import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import type { DeclarativeLoadCompatibilityFinding } from "./declarative.flow.ts";

/**
 * Declarative commands were invoked without `--experimental` and without
 * `[experimental.pgdelta] enabled = true`. Byte-matches Go's gate error
 * `"declarative commands require --experimental flag or pg-delta enabled in config"`
 * plus the `utils.CmdSuggestion`
 * (`apps/cli-go/cmd/db_schema_declarative.go:63-69`, deleted in CLI-1970;
 * last present at commit 7b469f5b3).
 */
export class DeclarativeNotEnabledError extends Data.TaggedError("DeclarativeNotEnabledError")<{
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
export class DeclarativeNonInteractiveError extends Data.TaggedError(
  "DeclarativeNonInteractiveError",
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
 * (both deleted in CLI-1970; last present at commit 7b469f5b3). Both fail
 * before any side effects run, matching cobra's pre-RunE validation.
 */
export class DeclarativeMutuallyExclusiveFlagsError extends Data.TaggedError(
  "DeclarativeMutuallyExclusiveFlagsError",
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
export class DeclarativeInvalidDbUrlError extends Data.TaggedError("DeclarativeInvalidDbUrlError")<{
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
export class DeclarativeNoFilesGeneratedError extends Data.TaggedError(
  "DeclarativeNoFilesGeneratedError",
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
export class DeclarativeDiffError extends Data.TaggedError("DeclarativeDiffError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** Sync stopped because a manifest-less legacy schema needs an explicit migration choice. */
export class DeclarativeCompatibilityError extends Data.TaggedError(
  "DeclarativeCompatibilityError",
)<{
  readonly message: string;
  /**
   * Recovery commands, printed bare on stderr by `Output.fail` INSTEAD of the
   * generic "Try rerunning the command with --debug" footer. A compatibility
   * gate is a deliberate refusal, not a crash, so it must never suggest
   * troubleshooting flags (same mechanism as {@link DeclarativeApplyError}).
   */
  readonly suggestion?: string;
  /** Structured only for a known implicit-extension failure during shadow load. */
  readonly loadFindings?: ReadonlyArray<DeclarativeLoadCompatibilityFinding>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Applying the generated migration to the local database failed. Wraps Go's
 * `applyMigrationToLocal` error; in interactive mode the handler offers a
 * reset+reapply before this surfaces
 * (`apps/cli-go/cmd/db_schema_declarative.go:397-435`, deleted in CLI-1970;
 * last present at commit 7b469f5b3).
 */
export class DeclarativeApplyError extends Data.TaggedError("DeclarativeApplyError")<{
  readonly message: string;
  /**
   * Set when this failure came from connecting to the local Postgres instance
   * (`dbConnection.connect`) rather than the migration SQL failing to apply.
   */
  readonly connect?: boolean;
  /**
   * Forwarded from the underlying typed failure this wraps (e.g. a
   * `KongReloadError`'s recovery hint, or a health-timeout architecture
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
 * used when wrapping a lower-level error (e.g. `resetLocalDatabase`'s
 * `KongReloadError`) into a {@link DeclarativeApplyError} so its
 * recovery hint isn't silently dropped by the wrap.
 */
export function readErrorSuggestion(error: unknown): string | undefined {
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

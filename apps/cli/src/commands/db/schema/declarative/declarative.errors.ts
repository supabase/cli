import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import type { DeclarativeLoadCompatibilityFinding } from "./declarative.flow.ts";

/**
 * Declarative commands were invoked without `--experimental` and without
 * `[experimental.pgdelta] enabled = true`; message text and suggestion are an established
 * output contract.
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
 * A target could not be resolved in non-interactive mode; message text is an established output
 * contract, shared by `generate` and the `sync` variants requiring `generate` first.
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
 * A mutually-exclusive flag group was violated: `generate`'s `db-url`/`linked`/`local`, or
 * `sync`'s `apply`/`no-apply`. Message text is an established output contract; both fail before
 * any side effects run.
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
 * The interactive custom-database-URL prompt was empty or unparseable; message text is an
 * established output contract.
 */
export class DeclarativeInvalidDbUrlError extends Data.TaggedError("DeclarativeInvalidDbUrlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** A migration stem would escape the migration directory or duplicate the SQL suffix. */
export class DeclarativeInvalidMigrationStemError extends Data.TaggedError(
  "DeclarativeInvalidMigrationStemError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** Transient apply needs explicit consent when no interactive prompt is available. */
export class DeclarativeTransientConfirmationRequiredError extends Data.TaggedError(
  "DeclarativeTransientConfirmationRequiredError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--transient` plans against the already-running local database and must not
 * `db start` as a side effect (fresh-volume start would migrate, seed, and
 * record history before the user confirms the planned SQL).
 */
export class DeclarativeLocalDbNotRunningError extends Data.TaggedError(
  "DeclarativeLocalDbNotRunningError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * `db schema declarative generate` ran but produced no declarative files (sync's post-generate
 * guard); message text is an established output contract.
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

/** Diffing declarative schema to migrations failed. A debug bundle is written before this surfaces. */
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
   * Recovery commands, printed bare on stderr by `Output.fail` instead of the generic
   * "Try rerunning the command with --debug" footer, since this is a refusal, not a crash.
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
 * Applying the generated migration to the local database failed; in interactive mode the handler
 * offers a reset+reapply before this surfaces.
 */
export class DeclarativeApplyError extends Data.TaggedError("DeclarativeApplyError")<{
  readonly message: string;
  /**
   * Set when this failure came from connecting to the local Postgres instance
   * (`dbConnection.connect`) rather than the migration SQL failing to apply.
   */
  readonly connect?: boolean;
  /**
   * Forwarded from the underlying typed failure this wraps (e.g. a `KongReloadError`'s recovery
   * hint) when the local-reset recovery path fails, so the wrap doesn't drop it.
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
 * Duck-types an optional `suggestion: string` off an arbitrary typed failure, used when wrapping
 * a lower-level error (e.g. `resetLocalDatabase`'s `KongReloadError`) into a
 * {@link DeclarativeApplyError} so its recovery hint isn't silently dropped by the wrap.
 */
export function readErrorSuggestion(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("suggestion" in error)) return undefined;
  const { suggestion } = error as { suggestion: unknown };
  return typeof suggestion === "string" ? suggestion : undefined;
}

import { Data } from "effect";

import { mintConfigTargetErrors } from "../../command-internal/project-target.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

interface PullNetworkErrorArgs {
  readonly message: string;
  readonly decode?: boolean;
}

interface PullStatusErrorArgs {
  readonly status: number;
  readonly body: string;
  readonly message: string;
}

/**
 * `--project-ref` target-resolution errors, minted via `mintConfigTargetErrors`. Its tags are
 * template-interpolated, so `error-actionability-coverage.unit.test.ts`'s static scan can't see
 * them there — each class is re-exported below under its own top-level export so the scan finds it.
 */
const pullTargetErrors = mintConfigTargetErrors("Pull");

/** `--project-ref` named a branch the parent project does not have. */
export const PullBranchNotFoundError = pullTargetErrors.BranchNotFoundError;
export type PullBranchNotFoundError = InstanceType<typeof PullBranchNotFoundError>;

/**
 * `--project-ref` named a branch (by name), but no project is linked to
 * search for branches under.
 */
export const PullBranchNotLinkedError = pullTargetErrors.BranchNotLinkedError;
export type PullBranchNotLinkedError = InstanceType<typeof PullBranchNotLinkedError>;

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate
 * exists but is not ref-shaped — corrupt or stale linked state.
 */
export const PullParentRefInvalidError = pullTargetErrors.ParentRefInvalidError;
export type PullParentRefInvalidError = InstanceType<typeof PullParentRefInvalidError>;

/** The resolved branch has no project ref yet (still provisioning). */
export const PullBranchNotReadyError = pullTargetErrors.BranchNotReadyError;
export type PullBranchNotReadyError = InstanceType<typeof PullBranchNotReadyError>;

/** A transport/decode failure resolving a branch-shaped `--project-ref` (`GET`-by-UUID or
 *  `FIND`-by-name). */
export class PullBranchResolveNetworkError extends Data.TaggedError(
  "PullBranchResolveNetworkError",
)<PullNetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** An unexpected HTTP status resolving a branch-shaped `--project-ref`. */
export class PullBranchResolveStatusError extends Data.TaggedError(
  "PullBranchResolveStatusError",
)<PullStatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** The global `-o`/`--output` flag was passed; `pull` only supports `--output-format` for
 *  machine output. */
export class PullOutputFlagUnsupportedError extends Data.TaggedError(
  "PullOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory. Only reachable when the user explicitly set it — beats every
 * step's own target resolution and network calls.
 */
export class PullWorkdirError extends Data.TaggedError("PullWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * At least one of the config file, `supabase/migrations`, or `supabase/functions` has
 * uncommitted or untracked changes with no interactive prompt to confirm past it. Only
 * `--force` overrides this guard; `--yes` never does.
 */
export class PullUncommittedChangesError extends Data.TaggedError("PullUncommittedChangesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

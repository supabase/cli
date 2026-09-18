import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";
import { mintConfigTargetErrors } from "../../../command-internal/project-target.ts";

interface NetworkErrorArgs {
  readonly message: string;
  readonly decode?: boolean;
}

interface StatusErrorArgs {
  readonly status: number;
  readonly body: string;
  readonly message: string;
}

/** Local config file missing or unparseable. Aborts before any network call. */
export class ConfigPullLoadConfigError extends Data.TaggedError("ConfigPullLoadConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory (`validateWorkdirIsDirectory`). Only reachable when the
 * user explicitly set it — beats the base config load and every network
 * call.
 */
export class ConfigPullWorkdirError extends Data.TaggedError("ConfigPullWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** The global `-o/--output` flag was passed; this command only supports `--output-format`. */
export class ConfigPullOutputFlagUnsupportedError extends Data.TaggedError(
  "ConfigPullOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

const targetErrors = mintConfigTargetErrors("ConfigPull");

/** `--project-ref` named a branch the parent project does not have. */
export const ConfigPullBranchNotFoundError = targetErrors.BranchNotFoundError;
export type ConfigPullBranchNotFoundError = InstanceType<typeof ConfigPullBranchNotFoundError>;

/** `--project-ref` named a branch (by name), but no project is linked to search branches under. */
export const ConfigPullBranchNotLinkedError = targetErrors.BranchNotLinkedError;
export type ConfigPullBranchNotLinkedError = InstanceType<typeof ConfigPullBranchNotLinkedError>;

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate exists but is not
 * ref-shaped — corrupt or stale linked state.
 */
export const ConfigPullParentRefInvalidError = targetErrors.ParentRefInvalidError;
export type ConfigPullParentRefInvalidError = InstanceType<typeof ConfigPullParentRefInvalidError>;

/** The resolved branch has no project ref yet (still provisioning). */
export const ConfigPullBranchNotReadyError = targetErrors.BranchNotReadyError;
export type ConfigPullBranchNotReadyError = InstanceType<typeof ConfigPullBranchNotReadyError>;

/**
 * A transport failure reading remote state over HTTP, shared by both the branch-lookup call and
 * the `/v2/projects/{ref}/config` read — the actionability is identical either way. The caller's
 * own message text distinguishes the two failure sites.
 */
export class ConfigPullReadNetworkError extends Data.TaggedError(
  "ConfigPullReadNetworkError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ConfigPullReadStatusError extends Data.TaggedError(
  "ConfigPullReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // A 404 names a user-selected resource (a wrong project ref, or a branch lookup) either way
    // — user-actionable.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * A label (`--remote-label` or a branch-derived name) already tracks a different project, or
 * another block already tracks this ref under a different name. The message must name the
 * actually conflicting block and its `project_id`, and suggest a different label or dropping
 * the flag.
 */
export class ConfigPullRemoteLabelCollisionError extends Data.TaggedError(
  "ConfigPullRemoteLabelCollisionError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * No `[remotes.*]` block's raw `project_id` literal matches the target ref, though one block's
 * `env(...)`-spelled `project_id` resolves to it — the config loader matches literally too, so
 * that block has never actually applied to this project. The message must name the offending
 * env var(s) and offer to replace the literal or pass `--remote-label` for a new block.
 */
export class ConfigPullRemoteEnvRefError extends Data.TaggedError("ConfigPullRemoteEnvRefError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The config file has uncommitted or untracked git changes and no human is available to confirm
 * the overwrite (non-interactive, machine-format, or `--yes`) — aborts rather than silently
 * overwriting uncommitted work. Only `--force` overrides this guard.
 */
export class ConfigPullUncommittedChangesError extends Data.TaggedError(
  "ConfigPullUncommittedChangesError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `applyConfigEdits` refused the edit (`ConfigEditRefusal` — a duplicate
 * table header, an array-of-tables or inline table on the edit's path, an
 * existing `env(...)` literal at the destination, a re-parse verification
 * mismatch, or a parse failure): the file has a structure this surgical
 * editor cannot safely rewrite.
 */
export class ConfigPullUnsupportedLayoutError extends Data.TaggedError(
  "ConfigPullUnsupportedLayoutError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The config file's bytes changed between the pre-confirmation read and the write step —
 * someone else edited it while the prompt was on screen. Refuses to write over a file it no
 * longer has an accurate picture of; rerunning re-reads the current state.
 */
export class ConfigPullFileChangedError extends Data.TaggedError("ConfigPullFileChangedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "conflict" };
  }
}

/** The atomic temp-file write/rename failed (`CliConfigWriteError`,
 * `@supabase/config/internal`) — a filesystem permission problem. */
export class ConfigPullWriteError extends Data.TaggedError("ConfigPullWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.permission, fingerprint_suffix: "filesystem" };
  }
}

/**
 * The post-plan convergence check found that a planned write still differs from the remote
 * after being applied to an in-memory projection — a defect in this command's own planner, not
 * a user-facing condition (see `configPullConvergenceCheck`). Raised before any file write; the
 * message must name the still-drifting paths and ask the user to report the bug.
 */
export class ConfigPullPlanDefectError extends Data.TaggedError("ConfigPullPlanDefectError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

/**
 * The post-plan schema-validation gate still finds the projected document unloadable after
 * dropping every family it could identify as the cause (`dropConfigPullUnvalidatableFamilies`)
 * — never user-facing, since a dropped family's writes restore that part of the document to its
 * pre-pull, already-valid state. Raised before any file write; the message asks the user to
 * report the bug.
 */
export class ConfigPullValidationFailedError extends Data.TaggedError(
  "ConfigPullValidationFailedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

import { Data } from "effect";

import { legacyMintConfigTargetErrors } from "../config/config.target.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * `--project-ref` target-resolution errors, minted the same way
 * `config diff`/`config pull` mint theirs (`legacyMintConfigTargetErrors`).
 * The tags are template-interpolated inside that shared helper, so
 * `error-actionability-coverage.unit.test.ts`'s static scan cannot see them
 * there — each minted class is re-exported here under its own top-level
 * export statement, under a `LegacyPull`-prefixed name, so the scan and its
 * runtime classification check both register it.
 */
const pullTargetErrors = legacyMintConfigTargetErrors("LegacyPull");

/** `--project-ref` named a branch the parent project does not have. */
export const LegacyPullBranchNotFoundError = pullTargetErrors.BranchNotFoundError;
export type LegacyPullBranchNotFoundError = InstanceType<typeof LegacyPullBranchNotFoundError>;

/**
 * `--project-ref` named a branch (by name), but no project is linked to
 * search for branches under.
 */
export const LegacyPullBranchNotLinkedError = pullTargetErrors.BranchNotLinkedError;
export type LegacyPullBranchNotLinkedError = InstanceType<typeof LegacyPullBranchNotLinkedError>;

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate
 * exists but is not ref-shaped — corrupt or stale linked state.
 */
export const LegacyPullParentRefInvalidError = pullTargetErrors.ParentRefInvalidError;
export type LegacyPullParentRefInvalidError = InstanceType<typeof LegacyPullParentRefInvalidError>;

/** The resolved branch has no project ref yet (still provisioning). */
export const LegacyPullBranchNotReadyError = pullTargetErrors.BranchNotReadyError;
export type LegacyPullBranchNotReadyError = InstanceType<typeof LegacyPullBranchNotReadyError>;

/**
 * The Go-compat global `-o/--output` flag was passed. `pull` is a net-new TS
 * command with no Go parity contract, so machine output goes through
 * `--output-format` only (mirrors `config diff`/`config pull`, CLI-2156).
 */
export class LegacyPullOutputFlagUnsupportedError extends Data.TaggedError(
  "LegacyPullOutputFlagUnsupportedError",
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
export class LegacyPullWorkdirError extends Data.TaggedError("LegacyPullWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The config file has uncommitted (or untracked) changes and there is no
 * human on hand to read the warning and answer the prompt honestly — mirrors
 * `config pull`'s own `LegacyConfigPullUncommittedChangesError` dirty-guard,
 * reused here because the orchestrator owns this check once instead of
 * delegating to `config pull`'s own guard. Only `--force` overrides this
 * guard; `--yes` never does, on any TTY.
 */
export class LegacyPullUncommittedChangesError extends Data.TaggedError(
  "LegacyPullUncommittedChangesError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

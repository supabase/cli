import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

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
export class LegacyConfigPullLoadConfigError extends Data.TaggedError(
  "LegacyConfigPullLoadConfigError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The Go-compat global `-o/--output` flag was passed. `config pull` is a
 * net-new TS command with no Go parity contract, so machine output goes
 * through `--output-format` only (mirrors `config diff`, CLI-2156).
 */
export class LegacyConfigPullOutputFlagUnsupportedError extends Data.TaggedError(
  "LegacyConfigPullOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** `--project-ref` named a branch the parent project does not have. */
export class LegacyConfigPullBranchNotFoundError extends Data.TaggedError(
  "LegacyConfigPullBranchNotFoundError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * `--project-ref` named a branch (by name), but no project is linked to
 * search for branches under. Mirrors `config diff`'s
 * `LegacyConfigDiffBranchNotLinkedError`.
 */
export class LegacyConfigPullBranchNotLinkedError extends Data.TaggedError(
  "LegacyConfigPullBranchNotLinkedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

/**
 * `--project-ref` named a branch (by name), and a parent-project candidate
 * exists but is not ref-shaped — corrupt or stale linked state. Mirrors
 * `config diff`'s `LegacyConfigDiffParentRefInvalidError`.
 */
export class LegacyConfigPullParentRefInvalidError extends Data.TaggedError(
  "LegacyConfigPullParentRefInvalidError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/**
 * The resolved branch has no project ref yet (still provisioning). Mirrors
 * `config diff`'s `LegacyConfigDiffBranchNotReadyError`.
 */
export class LegacyConfigPullBranchNotReadyError extends Data.TaggedError(
  "LegacyConfigPullBranchNotReadyError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "branch_not_ready" };
  }
}

/**
 * A transport failure reading remote state over HTTP — shared by BOTH the
 * branch-lookup call (`legacyResolveConfigTarget`'s `mapResolveError`) and
 * the `/v2/projects/{ref}/config` read: the actionability is identical
 * either way (an unreachable Management API), so this command keeps ONE
 * network/status pair rather than `config diff`'s two (which predate this
 * command's target-resolution reuse); the CALLER's own message text still
 * distinguishes the two failure sites.
 */
export class LegacyConfigPullReadNetworkError extends Data.TaggedError(
  "LegacyConfigPullReadNetworkError",
)<NetworkErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyConfigPullReadStatusError extends Data.TaggedError(
  "LegacyConfigPullReadStatusError",
)<StatusErrorArgs> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // A 404 names a user-selected resource (a wrong project ref, or a branch
    // lookup) either way — user-actionable, matching `config diff`'s own
    // rule for this same endpoint.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * A label that would govern this pull — either `--remote-label` or a
 * branch-derived name — names a block already tracking a different project
 * (`legacyResolveConfigPullDestination`, `label_collision`): either the
 * SAME-named `[remotes.<label>]` whose own `project_id` differs from the
 * target ref (or, for a branch-derived label, would have its `project_id`
 * silently REPLACED, stranding its own overrides), or a nonexistent
 * `--remote-label` while a DIFFERENT block already tracks this exact ref
 * under another name. The constructed message must name the actually
 * conflicting block (`conflictingBlock`) and its real `project_id`, and
 * offer the matching remedy — a different `--remote-label`/rename, or
 * dropping the flag to reuse the block that already tracks this ref.
 */
export class LegacyConfigPullRemoteLabelCollisionError extends Data.TaggedError(
  "LegacyConfigPullRemoteLabelCollisionError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * No `[remotes.*]` block's RAW `project_id` literal matches the target ref,
 * but one block's `env(...)`-spelled `project_id` RESOLVES to it
 * (`legacyResolveConfigPullDestination`, `env_project_id`) — plan of record
 * Decision 1: hard error, never reused, never rewritten, because the config
 * LOADER matches `project_id` literally too — an `env()`-spelled block that
 * merely resolves to a ref has never actually applied to any project
 * (`supabase start`/`config push` have both been ignoring it). The
 * constructed message must name the offending env var(s), explain that, and
 * offer the two remedies: replace the `env(...)` literal with the literal
 * project ref to make the block real, or pass `--remote-label` to write a
 * new block instead. Only reached when no `--remote-label` was given — see
 * `LegacyConfigPullRemoteLabelCollisionError`'s own doc comment for why an
 * explicit `--remote-label` is resolved first.
 */
export class LegacyConfigPullRemoteEnvRefError extends Data.TaggedError(
  "LegacyConfigPullRemoteEnvRefError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The config file has uncommitted (or untracked) changes (§1.4's git dirty
 * guard) and there is no human on hand to read the warning and answer the
 * prompt honestly: either the run is non-interactive/machine-format, or
 * `--yes` was passed (a TTY's own confirmation default flipping to "no" is
 * not a safeguard once `--yes` answers it automatically) — abort rather than
 * silently overwrite work the user hasn't committed. Only `--force`
 * overrides this guard; `--yes` never does, on any TTY.
 */
export class LegacyConfigPullUncommittedChangesError extends Data.TaggedError(
  "LegacyConfigPullUncommittedChangesError",
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
export class LegacyConfigPullUnsupportedLayoutError extends Data.TaggedError(
  "LegacyConfigPullUnsupportedLayoutError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The config file's bytes changed between the pre-confirmation read and the
 * write step (`pull.handler.ts` step 12) — someone else edited it while the
 * prompt was on screen. Refuses to write over a file it no longer has an
 * accurate picture of; rerunning the command re-reads the current state.
 */
export class LegacyConfigPullFileChangedError extends Data.TaggedError(
  "LegacyConfigPullFileChangedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "conflict" };
  }
}

/** The atomic temp-file write/rename failed (`CliConfigWriteError`,
 * `@supabase/config/internal`) — a filesystem permission problem. */
export class LegacyConfigPullWriteError extends Data.TaggedError("LegacyConfigPullWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.permission, fingerprint_suffix: "filesystem" };
  }
}

/**
 * The post-plan convergence check (plan §1.9) found that one or more paths
 * this run just planned to write STILL differ from the remote once the
 * planned writes are applied to an in-memory projection — a defect in this
 * command's own planner, never a user-facing condition (a genuine
 * unpushable-family residual is a `warnings[]` entry, not this error; see
 * `legacyConfigPullConvergenceCheck`). Raised BEFORE any file write, so
 * nothing was written when this fires. The constructed message must name the
 * still-drifting paths and state that nothing was written and the bug should
 * be reported.
 */
export class LegacyConfigPullPlanDefectError extends Data.TaggedError(
  "LegacyConfigPullPlanDefectError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

/**
 * `pull.handler.ts`'s post-plan schema-validation gate (CLI-2064's live-bug
 * fix) still finds the projected document unloadable after dropping every
 * family it could identify as the cause (`legacyDropConfigPullUnvalidatableFamilies`,
 * up to its own round cap) — never a user-facing condition: dropping a
 * family's writes restores that part of the document to its PRE-pull state,
 * which loaded successfully at the start of this very command, so reaching
 * this error means either the drop heuristic failed to identify the right
 * family or something else is structurally broken. Raised BEFORE any file
 * write, so nothing was written when this fires. The constructed message must
 * say so and ask the user to report the bug.
 */
export class LegacyConfigPullValidationFailedError extends Data.TaggedError(
  "LegacyConfigPullValidationFailedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

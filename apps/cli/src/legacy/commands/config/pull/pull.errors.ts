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
 * `--remote-label` named a block already tracking a different project —
 * either an existing `[remotes.<label>]` whose own `project_id` differs from
 * the target ref, or a nonexistent label while another block already tracks
 * this exact ref under a different name (`legacyResolveConfigPullDestination`,
 * `label_collision`). The constructed message must ask the user to pass a
 * different `--remote-label` (or drop the flag to reuse the block that
 * block reuse already selected).
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
 * Decision 1: hard error, never reused, never rewritten. The constructed
 * message must name the offending env var(s) and suggest either replacing
 * the `env(...)` literal with the literal project ref, or passing
 * `--remote-label` to target a different (or new) block instead.
 */
export class LegacyConfigPullRemoteEnvRefError extends Data.TaggedError(
  "LegacyConfigPullRemoteEnvRefError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * The config file has uncommitted changes (§1.4's git dirty guard) and the
 * run is non-interactive/machine-format with no `--force` — abort rather
 * than silently overwrite work the user hasn't committed. `--force`
 * overrides this guard; `--yes` does not (it only answers the confirmation
 * prompt, a distinct gate).
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

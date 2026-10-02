export const PULL_STEP_ORDER = ["config", "migration_history", "db", "functions"] as const;

export type PullStepId = (typeof PULL_STEP_ORDER)[number];

export type PullStepStatus = "changed" | "unchanged" | "skipped" | "planned" | "failed";

export interface PullStepFailure {
  readonly message: string;
  readonly suggestion?: string;
  /** The cause's own `_tag`, when present — lets a machine consumer classify a step failure
   *  without parsing `message`. */
  readonly code?: string;
}

export interface PullStepResult {
  readonly step: PullStepId;
  readonly status: PullStepStatus;
  /** Workdir-relative paths written by this step. Empty when nothing was written. */
  readonly written: ReadonlyArray<string>;
  /** Per-step machine detail; shape varies by step. See SIDE_EFFECTS.md's JSON payload shape. */
  readonly detail: Record<string, unknown>;
  /** Present for `status: "skipped"` (e.g. "not_needed", "declined", "--with-migration-history not set"). */
  readonly reason?: string;
  /** Present for `status: "failed"`. */
  readonly failure?: PullStepFailure;
}

export interface PullStepContext {
  readonly ref: string;
  readonly assumeYes: boolean;
}

export interface PullAggregate {
  readonly ref: string;
  readonly branch: string | undefined;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  /** Workdir-relative paths that had uncommitted or untracked changes at the start of this
   *  run — present (possibly empty) on every disposition, not just a dirty-tree abort. */
  readonly dirtyPaths: ReadonlyArray<string>;
  readonly results: ReadonlyArray<PullStepResult>;
}

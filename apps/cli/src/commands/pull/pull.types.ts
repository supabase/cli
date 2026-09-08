export const LEGACY_PULL_STEP_ORDER = ["config", "migration_history", "db", "functions"] as const;

export type LegacyPullStepId = (typeof LEGACY_PULL_STEP_ORDER)[number];

export type LegacyPullStepStatus = "changed" | "unchanged" | "skipped" | "planned" | "failed";

export interface LegacyPullStepFailure {
  readonly message: string;
  readonly suggestion?: string;
}

export interface LegacyPullStepResult {
  readonly step: LegacyPullStepId;
  readonly status: LegacyPullStepStatus;
  /** Workdir-relative paths written by this step. Empty when nothing was written. */
  readonly written: ReadonlyArray<string>;
  /** Per-step machine detail, shape varies by step (see plan's payload section). */
  readonly detail: Record<string, unknown>;
  /** Present for `status: "skipped"` (e.g. "not_needed", "declined", "--with-migration-history not set"). */
  readonly reason?: string;
  /** Present for `status: "failed"`. */
  readonly failure?: LegacyPullStepFailure;
}

export interface LegacyPullStepContext {
  readonly ref: string;
  readonly branch: string | undefined;
  readonly dryRun: boolean;
  readonly assumeYes: boolean;
}

export interface LegacyPullAggregate {
  readonly ref: string;
  readonly branch: string | undefined;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly results: ReadonlyArray<LegacyPullStepResult>;
}

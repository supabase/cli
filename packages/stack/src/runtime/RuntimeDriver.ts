import { Data, Effect } from "effect";
import type { StackId } from "../public/StackId.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";

/** The exact identity used when touching a private runtime resource. */
export interface RuntimeWorkloadKey {
  readonly stackId: StackId;
  readonly desiredGeneration: number;
  readonly workloadId: string;
  readonly specHash: string;
}

/** A driver only reports states that can be acted on by the reconciler. */
export type ObservedWorkloadState = "absent" | "starting" | "ready" | "stopped" | "failed";

export interface ObservedWorkload extends RuntimeWorkloadKey {
  readonly state: ObservedWorkloadState;
  readonly error?: string;
}

export type RuntimeWorkload = PlannedWorkload;

export interface RuntimeDriver {
  /** Enumerates only private resources owned by this exact stack identity. */
  readonly observe: (
    stackId: StackId,
  ) => Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError>;
  /** Starts one exact resource and returns after its readiness probe succeeds. */
  readonly start: (
    key: RuntimeWorkloadKey,
    workload: RuntimeWorkload,
  ) => Effect.Effect<ObservedWorkload, RuntimeDriverError>;
  /** Stops one exact resource; no other generation or stack may be touched. */
  readonly stop: (key: RuntimeWorkloadKey) => Effect.Effect<void, RuntimeDriverError>;
  /** Removes one exact resource; no other generation or stack may be touched. */
  readonly remove: (key: RuntimeWorkloadKey) => Effect.Effect<void, RuntimeDriverError>;
}

export class RuntimeDriverError extends Data.TaggedError("RuntimeDriverError")<{
  readonly message: string;
  readonly stackId?: StackId;
  readonly workloadId?: string;
}> {}

export class RuntimeGenerationMismatchError extends Data.TaggedError(
  "RuntimeGenerationMismatchError",
)<{
  readonly message: string;
  readonly expectedGeneration: number;
  readonly actualGeneration: number;
}> {}

export class RuntimeReadinessTimeoutError extends Data.TaggedError("RuntimeReadinessTimeoutError")<{
  readonly message: string;
  readonly stackId: StackId;
  readonly workloadId: string;
  readonly desiredGeneration: number;
}> {}

export class RuntimeRestartBudgetExceededError extends Data.TaggedError(
  "RuntimeRestartBudgetExceededError",
)<{
  readonly message: string;
  readonly stackId: StackId;
  readonly workloadId: string;
  readonly attempts: number;
}> {}

import { Data, Effect, Stream } from "effect";
import type { StackId } from "../public/StackId.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";

/** The exact identity used when touching a private runtime resource. */
export interface RuntimeWorkloadKey {
  readonly stackId: StackId;
  readonly workloadId: string;
  readonly specHash: string;
}

/** Exact stack-wide runtime cleanup requested after reconciliation or owner recovery. */
export interface RuntimeCleanupRequest {
  readonly stackId: StackId;
  /** Remove persistent runtime volumes in addition to ephemeral containers/networks. */
  readonly destroy: boolean;
}

/** A driver only reports states that can be acted on by the reconciler. */
type ObservedWorkloadState = "absent" | "starting" | "ready" | "stopped" | "failed";

export interface ObservedWorkload extends RuntimeWorkloadKey {
  readonly state: ObservedWorkloadState;
  readonly error?: string;
}

type RuntimeWorkload = PlannedWorkload;

export interface RuntimeDriver {
  /** Unexpected post-readiness failures, scoped to this driver owner. */
  readonly watchFailures: Stream.Stream<ObservedWorkload, RuntimeDriverError>;
  /** Enumerates only private resources owned by this exact stack identity. */
  readonly observe: (
    stackId: StackId,
  ) => Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError>;
  /** Starts one exact resource and returns after its readiness probe succeeds. */
  readonly start: (
    key: RuntimeWorkloadKey,
    workload: RuntimeWorkload,
  ) => Effect.Effect<ObservedWorkload, RuntimeDriverError>;
  /** Stops one exact resource; no other stack may be touched. */
  readonly stop: (key: RuntimeWorkloadKey) => Effect.Effect<void, RuntimeDriverError>;
  /** Removes one exact resource; no other stack may be touched. */
  readonly remove: (key: RuntimeWorkloadKey) => Effect.Effect<void, RuntimeDriverError>;
  /**
   * Cleans up exact resources belonging to one stack. Ordinary stop retains volumes; destructive
   * cleanup removes them after containers and networks have been removed.
   */
  readonly cleanup: (request: RuntimeCleanupRequest) => Effect.Effect<void, RuntimeDriverError>;
}

export class RuntimeDriverError extends Data.TaggedError("RuntimeDriverError")<{
  readonly message: string;
  readonly stackId?: StackId;
  readonly workloadId?: string;
  readonly cause?: unknown;
}> {}

export class RuntimeRestartBudgetExceededError extends Data.TaggedError(
  "RuntimeRestartBudgetExceededError",
)<{
  readonly message: string;
  readonly stackId: StackId;
  readonly workloadId: string;
  readonly attempts: number;
}> {}

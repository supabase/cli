import type { Effect } from "effect";
import type { StackDefinition } from "../model/Compiler.ts";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { PersistedServiceInstance } from "../model/ServiceRegistry.ts";
import type { StackId } from "../public/StackId.ts";
import type { StackError } from "../public/Errors.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { PersistedSecretValues, PersistedStackState } from "../state/StackState.ts";

/** Runtime input retained for ingress and artifact preparation boundaries. */
export interface LifecycleInput {
  readonly stackId: StackId;
  readonly state: PersistedStackState;
  readonly definition: StackDefinition;
  readonly secrets: PersistedSecretValues;
  readonly plan: ExecutionPlan;
}

/** Exact per-instance context passed to runtime lifecycle and snapshot operations. */
export interface InstanceRuntimeInput {
  readonly stackId: StackId;
  readonly state: PersistedStackState;
  readonly instance: PersistedServiceInstance;
  readonly plan: ExecutionPlan;
  readonly operation: {
    readonly id: string;
    readonly generation: number;
  };
  /** Publishes inspector bindings only after this operation still owns the pending journal. */
  readonly publishStartupBindings?: (
    bindings: ReadonlyArray<RuntimeBindingPublication>,
  ) => Effect.Effect<void, StackError>;
}

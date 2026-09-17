import { Cause, Match, Option, Predicate, type Deferred, type Exit } from "effect";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { StackError } from "../public/Errors.ts";
import type { StackRecovery } from "../public/Status.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { CapabilityState } from "./CapabilityState.ts";

type StableStackState =
  | { readonly _tag: "stopped"; readonly session: "uninitialized" | "initialized" }
  | { readonly _tag: "running" };

type RecoveryState =
  | {
      readonly _tag: "stop-required";
      readonly cause: Cause.Cause<StackError>;
    }
  | {
      readonly _tag: "destroy-required";
      readonly evidence:
        | { readonly _tag: "persisted-intent" }
        | { readonly _tag: "failed"; readonly cause: Cause.Cause<StackError> };
    };

type StoppablePriorState =
  | StableStackState
  | Extract<RecoveryState, { readonly _tag: "stop-required" }>;

type StartRecoveryState = {
  readonly _tag: "start-recovery";
  readonly attempt: symbol;
  readonly completion: LifecycleCompletion;
  readonly cause: Cause.Cause<StackError>;
};

export type LifecycleKind = "start" | "stop" | "destroy";
type LifecycleCompletion = Deferred.Deferred<Exit.Exit<void, StackError>, never>;

const causeMessage = (cause: Cause.Cause<StackError>, fallback: string): string => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && error.value.message.length > 0 ? error.value.message : fallback;
};

export const recoveryForState = (state: StackControlState): StackRecovery | undefined =>
  Match.value(state).pipe(
    Match.when({ _tag: "stop-required" }, (value) => ({
      operation: "stop" as const,
      message: causeMessage(
        value.cause,
        "Runtime cleanup is required; retry stop before proceeding",
      ),
    })),
    Match.when({ _tag: "destroy-required" }, (value) => ({
      operation: "destroy" as const,
      message: Predicate.isTagged(value.evidence, "failed")
        ? causeMessage(
            value.evidence.cause,
            "Destructive cleanup is required; retry destroy before proceeding",
          )
        : "Destructive cleanup is required; retry destroy before proceeding",
    })),
    Match.when({ _tag: "stopped" }, () => undefined),
    Match.when({ _tag: "running" }, () => undefined),
    Match.when({ _tag: "starting" }, () => undefined),
    Match.when({ _tag: "stopping" }, () => undefined),
    Match.when({ _tag: "destroying" }, () => undefined),
    Match.when({ _tag: "start-recovery" }, () => undefined),
    Match.exhaustive,
  );

export type StackControlState =
  | StableStackState
  | RecoveryState
  | StartRecoveryState
  | {
      readonly _tag: "starting";
      readonly attempt: symbol;
      readonly completion: LifecycleCompletion;
      readonly prior: StableStackState;
    }
  | {
      readonly _tag: "stopping";
      readonly attempt: symbol;
      readonly completion: LifecycleCompletion;
      readonly prior: StoppablePriorState;
    }
  | {
      readonly _tag: "destroying";
      readonly attempt: symbol;
      readonly completion: LifecycleCompletion;
      readonly prior: StableStackState | RecoveryState;
    };

export type SupervisorSnapshot = Readonly<{
  readonly stack: StackControlState;
  readonly sessionId: symbol;
  readonly plan: ExecutionPlan | undefined;
  readonly capabilities: ReadonlyMap<CapabilityName, CapabilityState>;
}>;

export const isTransitioning = (
  state: StackControlState,
): state is Extract<StackControlState, { readonly attempt: symbol }> =>
  Predicate.isTagged("starting")(state) ||
  Predicate.isTagged("stopping")(state) ||
  Predicate.isTagged("destroying")(state) ||
  Predicate.isTagged("start-recovery")(state);

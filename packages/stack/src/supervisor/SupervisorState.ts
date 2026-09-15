import { Match, type Cause, type Deferred, type Exit } from "effect";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { StackError } from "../public/Errors.ts";
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
export type LifecycleCompletion = Deferred.Deferred<Exit.Exit<void, StackError>, never>;
type CommandRejectionReason = "lifecycle-transition" | "stop-required" | "destroy-required";

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

type TransitionState =
  | Extract<StackControlState, { readonly _tag: "starting" }>
  | Extract<StackControlState, { readonly _tag: "stopping" }>
  | Extract<StackControlState, { readonly _tag: "destroying" }>;

export type CommandAdmission =
  | { readonly _tag: "accepted"; readonly state: TransitionState }
  | {
      readonly _tag: "rejected";
      readonly reason: CommandRejectionReason;
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
  state._tag === "starting" ||
  state._tag === "stopping" ||
  state._tag === "destroying" ||
  state._tag === "start-recovery";

export const publicPhase = (
  state: StackControlState,
): "stopped" | "starting" | "running" | "stopping" | "destroying" =>
  Match.value(state).pipe(
    Match.when({ _tag: "stopped" }, () => "stopped" as const),
    Match.when({ _tag: "running" }, () => "running" as const),
    Match.when({ _tag: "starting", prior: { _tag: "running" } }, () => "running" as const),
    Match.when({ _tag: "starting" }, () => "starting" as const),
    Match.when({ _tag: "stopping" }, () => "stopping" as const),
    Match.when({ _tag: "destroying" }, () => "destroying" as const),
    Match.when({ _tag: "stop-required" }, () => "stopping" as const),
    Match.when({ _tag: "start-recovery" }, () => "stopping" as const),
    Match.when({ _tag: "destroy-required" }, () => "destroying" as const),
    Match.exhaustive,
  );

export const command = (
  state: StackControlState,
  kind: LifecycleKind,
  completion: LifecycleCompletion,
): CommandAdmission => {
  const attempt = Symbol(kind);
  const rejected = (reason: CommandRejectionReason): CommandAdmission => ({
    _tag: "rejected",
    reason,
  });
  const accepted = (next: TransitionState): CommandAdmission => ({
    _tag: "accepted",
    state: next,
  });
  const start = Match.value(state).pipe(
    Match.when({ _tag: "stopped" }, (prior) =>
      accepted({ _tag: "starting", attempt, completion, prior }),
    ),
    Match.when({ _tag: "running" }, (prior) =>
      accepted({ _tag: "starting", attempt, completion, prior }),
    ),
    Match.when({ _tag: "stop-required" }, () => rejected("stop-required")),
    Match.when({ _tag: "destroy-required" }, () => rejected("destroy-required")),
    Match.when({ _tag: "starting" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "start-recovery" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "stopping" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "destroying" }, () => rejected("lifecycle-transition")),
    Match.exhaustive,
  );
  const stop = Match.value(state).pipe(
    Match.when({ _tag: "stopped" }, (prior) =>
      accepted({ _tag: "stopping", attempt, completion, prior }),
    ),
    Match.when({ _tag: "running" }, (prior) =>
      accepted({ _tag: "stopping", attempt, completion, prior }),
    ),
    Match.when({ _tag: "stop-required" }, (prior) =>
      accepted({ _tag: "stopping", attempt, completion, prior }),
    ),
    Match.when({ _tag: "destroy-required" }, () => rejected("destroy-required")),
    Match.when({ _tag: "starting" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "start-recovery" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "stopping" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "destroying" }, () => rejected("lifecycle-transition")),
    Match.exhaustive,
  );
  const destroy = Match.value(state).pipe(
    Match.when({ _tag: "stopped" }, (prior) =>
      accepted({ _tag: "destroying", attempt, completion, prior }),
    ),
    Match.when({ _tag: "running" }, (prior) =>
      accepted({ _tag: "destroying", attempt, completion, prior }),
    ),
    Match.when({ _tag: "stop-required" }, (prior) =>
      accepted({ _tag: "destroying", attempt, completion, prior }),
    ),
    Match.when({ _tag: "destroy-required" }, (prior) =>
      accepted({ _tag: "destroying", attempt, completion, prior }),
    ),
    Match.when({ _tag: "starting" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "start-recovery" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "stopping" }, () => rejected("lifecycle-transition")),
    Match.when({ _tag: "destroying" }, () => rejected("lifecycle-transition")),
    Match.exhaustive,
  );
  return Match.value(kind).pipe(
    Match.when("start", () => start),
    Match.when("stop", () => stop),
    Match.when("destroy", () => destroy),
    Match.exhaustive,
  );
};

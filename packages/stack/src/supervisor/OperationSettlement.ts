import { Cause, Deferred, Exit, Match, Predicate } from "effect";
import type { ActivationResult } from "../gateway/Gateway.ts";
import type { GatewayActivationError, StackError } from "../public/Errors.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { CleanupOutcome } from "./Lifecycle.ts";
import {
  cleanupFailed,
  completeStarting,
  restoreStarting,
  type CapabilityState,
} from "./CapabilityState.ts";
import {
  isTransitioning,
  type StackControlState,
  type SupervisorSnapshot,
} from "./SupervisorState.ts";

type ActivationFailure = GatewayActivationError | StackError;
export type ActivationExit = Exit.Exit<ActivationResult, ActivationFailure>;
export type EndpointExit = Exit.Exit<ActivationResult["endpoint"], ActivationFailure>;
export type CommandResult =
  | { readonly _tag: "succeeded" }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<StackError>;
      readonly cleanup: CleanupOutcome;
      readonly durable: "stopped" | "unsafe";
    };
type RetirementExit = Exit.Exit<boolean, StackError>;

export type ActivationOwner =
  | {
      readonly _tag: "endpoint";
      readonly capability: CapabilityName;
      readonly endpoint: Deferred.Deferred<EndpointExit, never>;
      readonly priorRoot: boolean;
    }
  | {
      readonly _tag: "activation";
      readonly capability: CapabilityName;
      readonly completion: Deferred.Deferred<ActivationExit, never>;
    };
type ActivationSettlement =
  | (Extract<ActivationOwner, { readonly _tag: "endpoint" }> & { readonly result: EndpointExit })
  | (Extract<ActivationOwner, { readonly _tag: "activation" }> & {
      readonly result: ActivationExit;
    });
type RetirementOwner = {
  readonly _tag: "retirement";
  readonly capability: CapabilityName;
  readonly operation: symbol;
  readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
  readonly result: RetirementExit;
};
type LifecycleOwner = {
  readonly _tag: "lifecycle";
  readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
  readonly result: CommandResult;
};
export type SettlementOwner = ActivationSettlement | RetirementOwner | LifecycleOwner;
type SettlementNotification =
  | {
      readonly _tag: "endpoint";
      readonly completion: Deferred.Deferred<EndpointExit, never>;
      readonly result: EndpointExit;
    }
  | {
      readonly _tag: "activation";
      readonly completion: Deferred.Deferred<ActivationExit, never>;
      readonly result: ActivationExit;
    }
  | {
      readonly _tag: "retirement";
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly result: Exit.Exit<void, StackError>;
    }
  | {
      readonly _tag: "lifecycle";
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly result: Exit.Exit<void, StackError>;
    };
type Settlement = Readonly<{
  readonly snapshot: SupervisorSnapshot;
  readonly notification: SettlementNotification;
  readonly reconcile: "all-ready" | "none";
}>;

export const matchesActivationOwner = (
  snapshot: SupervisorSnapshot,
  owner: ActivationOwner,
): boolean => {
  const current = snapshot.capabilities.get(owner.capability);
  return Match.value(owner).pipe(
    Match.tag(
      "endpoint",
      (event) =>
        Predicate.isTagged(current, "ready") &&
        Predicate.isTagged(current.endpoint, "resolving") &&
        current.endpoint.deferred === event.endpoint,
    ),
    Match.tag(
      "activation",
      (event) =>
        Predicate.isTagged(current, "starting") &&
        Predicate.isTagged(current.completion, "activation") &&
        current.completion.deferred === event.completion,
    ),
    Match.exhaustive,
  );
};

export const stopRecoverySnapshot = (
  snapshot: SupervisorSnapshot,
  cause: Cause.Cause<StackError>,
): SupervisorSnapshot =>
  Match.value(snapshot.stack).pipe(
    Match.tag("running", () => ({
      ...snapshot,
      stack: { _tag: "stop-required" as const, cause },
    })),
    Match.when({ _tag: "starting", prior: { _tag: "running" } }, (state) => ({
      ...snapshot,
      stack: {
        _tag: "start-recovery" as const,
        cause,
        attempt: state.attempt,
        completion: state.completion,
      },
    })),
    Match.tag(
      "stopped",
      "stop-required",
      "destroy-required",
      "start-recovery",
      "starting",
      "stopping",
      "destroying",
      () => snapshot,
    ),
    Match.exhaustive,
  );

export const settleActivationOwner = (
  snapshot: SupervisorSnapshot,
  owner: ActivationSettlement,
): Settlement => {
  const nextSnapshot = Match.value(owner).pipe(
    Match.tag("endpoint", (event) => {
      const current = snapshot.capabilities.get(event.capability);
      if (
        !Predicate.isTagged(current, "ready") ||
        !Predicate.isTagged(current.endpoint, "resolving") ||
        !matchesActivationOwner(snapshot, event)
      ) {
        return snapshot;
      }
      const next: CapabilityState = Exit.isSuccess(event.result)
        ? { ...current, endpoint: { _tag: "resolved", endpoint: event.result.value } }
        : { ...current, root: event.priorRoot, endpoint: { _tag: "unresolved" } };
      return {
        ...snapshot,
        capabilities: new Map(snapshot.capabilities).set(event.capability, next),
      };
    }),
    Match.tag("activation", (event) => {
      const current = snapshot.capabilities.get(event.capability);
      if (
        !Predicate.isTagged(current, "starting") ||
        !Predicate.isTagged(current.completion, "activation") ||
        !matchesActivationOwner(snapshot, event)
      ) {
        return snapshot;
      }
      const next = Exit.isSuccess(event.result)
        ? completeStarting(
            current,
            { _tag: "resolved", endpoint: event.result.value.endpoint },
            true,
          )
        : Predicate.isTagged(snapshot.stack, "stopped")
          ? { _tag: "stopped" as const }
          : restoreStarting(current);
      return {
        ...snapshot,
        capabilities: new Map(snapshot.capabilities).set(event.capability, next),
      };
    }),
    Match.exhaustive,
  );
  const notification = Match.value(owner).pipe(
    Match.tag("endpoint", (event) => ({
      _tag: "endpoint" as const,
      completion: event.endpoint,
      result: event.result,
    })),
    Match.tag("activation", (event) => ({
      _tag: "activation" as const,
      completion: event.completion,
      result: event.result,
    })),
    Match.exhaustive,
  );
  return { snapshot: nextSnapshot, notification, reconcile: "all-ready" as const };
};

export const settleRetirementOwner = (
  snapshot: SupervisorSnapshot,
  owner: RetirementOwner,
): Settlement => {
  const current = snapshot.capabilities.get(owner.capability);
  if (
    Predicate.isTagged(current, "stopping") &&
    current.operation === owner.operation &&
    current.completion === owner.completion
  ) {
    if (Exit.isSuccess(owner.result) && owner.result.value) {
      const next: CapabilityState = {
        _tag: "dormant",
        sessionId: current.sessionId,
        traffic: current.traffic,
        root: false,
        retirement: { _tag: "disarmed" },
      };
      return {
        snapshot: {
          ...snapshot,
          capabilities: new Map(snapshot.capabilities).set(owner.capability, next),
        },
        notification: {
          _tag: "retirement",
          completion: owner.completion,
          result: Exit.map(owner.result, () => undefined),
        },
        reconcile: "all-ready",
      };
    }
    if (Exit.isSuccess(owner.result))
      return {
        snapshot,
        notification: { _tag: "retirement", completion: owner.completion, result: Exit.void },
        reconcile: "none",
      };
    return {
      snapshot: {
        ...stopRecoverySnapshot(snapshot, owner.result.cause),
        capabilities: new Map(snapshot.capabilities).set(
          owner.capability,
          cleanupFailed(current, owner.result.cause),
        ),
      },
      notification: {
        _tag: "retirement",
        completion: owner.completion,
        result: Exit.failCause(owner.result.cause),
      },
      reconcile: "none",
    };
  }
  return {
    snapshot,
    notification: {
      _tag: "retirement",
      completion: owner.completion,
      result: Exit.isSuccess(owner.result) ? Exit.void : Exit.failCause(owner.result.cause),
    },
    reconcile: "none",
  };
};

const commandResultExit = (operation: CommandResult): Exit.Exit<void, StackError> =>
  Predicate.isTagged(operation, "failed") ? Exit.failCause(operation.cause) : Exit.void;

const settleStartingFailure = (
  state: Extract<StackControlState, { readonly _tag: "starting" }>,
  operation: Extract<CommandResult, { readonly _tag: "failed" }>,
): StackControlState =>
  Match.value(state.prior).pipe(
    Match.tag("running", (prior) =>
      Match.value(operation.cleanup).pipe(
        Match.tag("unproven", () => ({ _tag: "stop-required" as const, cause: operation.cause })),
        Match.tag("proven", () => prior),
        Match.exhaustive,
      ),
    ),
    Match.tag("stopped", () =>
      Match.value(operation.cleanup).pipe(
        Match.tag("proven", () =>
          operation.durable === "stopped"
            ? { _tag: "stopped" as const, session: "initialized" as const }
            : { _tag: "stop-required" as const, cause: operation.cause },
        ),
        Match.tag("unproven", () => ({ _tag: "stop-required" as const, cause: operation.cause })),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

export const settleLifecycleOwner = (
  snapshot: SupervisorSnapshot,
  owner: LifecycleOwner,
): Settlement => {
  const current = snapshot.stack;
  const operation = owner.result;
  const matches = isTransitioning(current) && current.completion === owner.completion;
  if (!matches)
    return {
      snapshot,
      notification: {
        _tag: "lifecycle",
        completion: owner.completion,
        result: commandResultExit(operation),
      },
      reconcile: "all-ready",
    };
  const completionCause = Match.value(current).pipe(
    Match.tag("start-recovery", (state) =>
      Match.value(operation).pipe(
        Match.tag("succeeded", () => state.cause),
        Match.tag("failed", (failure) => Cause.combine(state.cause, failure.cause)),
        Match.exhaustive,
      ),
    ),
    Match.tag("starting", () => undefined),
    Match.tag("stopping", () => undefined),
    Match.tag("destroying", () => undefined),
    Match.exhaustive,
  );
  const completion: Exit.Exit<void, StackError> =
    completionCause === undefined ? commandResultExit(operation) : Exit.failCause(completionCause);
  const next: StackControlState = Match.value(current).pipe(
    Match.tag("start-recovery", (state) => ({
      _tag: "stop-required" as const,
      cause: Match.value(operation).pipe(
        Match.tag("succeeded", () => state.cause),
        Match.tag("failed", (failure) => Cause.combine(state.cause, failure.cause)),
        Match.exhaustive,
      ),
    })),
    Match.tag("starting", (state) =>
      Match.value(operation).pipe(
        Match.tag("succeeded", () => ({ _tag: "running" as const })),
        Match.tag("failed", (failure) => settleStartingFailure(state, failure)),
        Match.exhaustive,
      ),
    ),
    Match.tag("stopping", () =>
      Match.value(operation).pipe(
        Match.tag("succeeded", () => ({
          _tag: "stopped" as const,
          session: "initialized" as const,
        })),
        Match.tag("failed", (failure) => ({
          _tag: "stop-required" as const,
          cause: failure.cause,
        })),
        Match.exhaustive,
      ),
    ),
    Match.tag("destroying", () =>
      Match.value(operation).pipe(
        Match.tag("succeeded", () => ({
          _tag: "stopped" as const,
          session: "initialized" as const,
        })),
        Match.tag("failed", (failure) => ({
          _tag: "destroy-required" as const,
          evidence: { _tag: "failed" as const, cause: failure.cause },
        })),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
  return {
    snapshot: { ...snapshot, stack: next },
    notification: { _tag: "lifecycle", completion: owner.completion, result: completion },
    reconcile: "all-ready",
  };
};

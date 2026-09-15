import { Cause, Deferred, Exit, Match } from "effect";
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
    Match.when(
      { _tag: "endpoint" },
      (event) =>
        current?._tag === "ready" &&
        current.endpoint._tag === "resolving" &&
        current.endpoint.deferred === event.endpoint,
    ),
    Match.when(
      { _tag: "activation" },
      (event) =>
        current?._tag === "starting" &&
        current.completion._tag === "activation" &&
        current.completion.deferred === event.completion,
    ),
    Match.exhaustive,
  );
};

export const stopRecoverySnapshot = (
  snapshot: SupervisorSnapshot,
  cause: Cause.Cause<StackError>,
): SupervisorSnapshot =>
  snapshot.stack._tag === "running" ||
  (snapshot.stack._tag === "starting" && snapshot.stack.prior._tag === "running")
    ? {
        ...snapshot,
        stack:
          snapshot.stack._tag === "starting"
            ? {
                _tag: "start-recovery",
                cause,
                attempt: snapshot.stack.attempt,
                completion: snapshot.stack.completion,
              }
            : { _tag: "stop-required", cause },
      }
    : snapshot;

export const settleActivationOwner = (
  snapshot: SupervisorSnapshot,
  owner: ActivationSettlement,
): Settlement => {
  const current = snapshot.capabilities.get(owner.capability);
  if (
    owner._tag === "endpoint" &&
    current?._tag === "ready" &&
    current.endpoint._tag === "resolving" &&
    matchesActivationOwner(snapshot, owner)
  ) {
    const next: CapabilityState = Exit.isSuccess(owner.result)
      ? { ...current, endpoint: { _tag: "resolved", endpoint: owner.result.value } }
      : { ...current, root: owner.priorRoot, endpoint: { _tag: "unresolved" } };
    return {
      snapshot: {
        ...snapshot,
        capabilities: new Map(snapshot.capabilities).set(owner.capability, next),
      },
      notification: { _tag: "endpoint", completion: owner.endpoint, result: owner.result },
      reconcile: "all-ready",
    };
  }
  if (
    owner._tag === "activation" &&
    current?._tag === "starting" &&
    current.completion._tag === "activation" &&
    matchesActivationOwner(snapshot, owner)
  ) {
    const next = Exit.isSuccess(owner.result)
      ? completeStarting(current, { _tag: "resolved", endpoint: owner.result.value.endpoint }, true)
      : restoreStarting(current);
    return {
      snapshot: {
        ...snapshot,
        capabilities: new Map(snapshot.capabilities).set(owner.capability, next),
      },
      notification: { _tag: "activation", completion: owner.completion, result: owner.result },
      reconcile: "all-ready",
    };
  }
  const notification = Match.value(owner).pipe(
    Match.when({ _tag: "endpoint" }, (event) => ({
      _tag: "endpoint" as const,
      completion: event.endpoint,
      result: event.result,
    })),
    Match.when({ _tag: "activation" }, (event) => ({
      _tag: "activation" as const,
      completion: event.completion,
      result: event.result,
    })),
    Match.exhaustive,
  );
  return {
    snapshot,
    notification,
    reconcile: "all-ready",
  };
};

export const settleRetirementOwner = (
  snapshot: SupervisorSnapshot,
  owner: RetirementOwner,
): Settlement => {
  const current = snapshot.capabilities.get(owner.capability);
  if (
    current?._tag === "stopping" &&
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
        result: operation._tag === "succeeded" ? Exit.void : Exit.failCause(operation.cause),
      },
      reconcile: "all-ready",
    };
  const completion =
    current._tag === "start-recovery"
      ? Exit.failCause(
          operation._tag === "succeeded"
            ? current.cause
            : Cause.combine(current.cause, operation.cause),
        )
      : operation._tag === "succeeded"
        ? Exit.void
        : Exit.failCause(operation.cause);
  const next: StackControlState = Match.value(current).pipe(
    Match.when({ _tag: "start-recovery" }, (state) => ({
      _tag: "stop-required" as const,
      cause:
        operation._tag === "succeeded" ? state.cause : Cause.combine(state.cause, operation.cause),
    })),
    Match.when({ _tag: "starting" }, (state) =>
      operation._tag === "succeeded"
        ? { _tag: "running" as const }
        : state.prior._tag === "running"
          ? operation.cleanup._tag === "unproven"
            ? { _tag: "stop-required" as const, cause: operation.cause }
            : state.prior
          : operation.cleanup._tag === "proven" && operation.durable === "stopped"
            ? { _tag: "stopped" as const, session: "initialized" as const }
            : { _tag: "stop-required" as const, cause: operation.cause },
    ),
    Match.when({ _tag: "stopping" }, () =>
      operation._tag === "succeeded"
        ? { _tag: "stopped" as const, session: "initialized" as const }
        : { _tag: "stop-required" as const, cause: operation.cause },
    ),
    Match.when({ _tag: "destroying" }, () =>
      operation._tag === "succeeded"
        ? { _tag: "stopped" as const, session: "initialized" as const }
        : {
            _tag: "destroy-required" as const,
            evidence: { _tag: "failed" as const, cause: operation.cause },
          },
    ),
    Match.exhaustive,
  );
  return {
    snapshot: { ...snapshot, stack: next },
    notification: { _tag: "lifecycle", completion: owner.completion, result: completion },
    reconcile: "all-ready",
  };
};

import { Effect, SubscriptionRef } from "effect";
import { ServiceState, type ServiceStatus } from "./ServiceState.ts";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ServiceEvent =
  | { readonly _tag: "DependenciesSatisfied" }
  | { readonly _tag: "DependencyFailed"; readonly error: string }
  | {
      readonly _tag: "ProcessSpawned";
      readonly pid: number;
      readonly startedAt: number;
    }
  | { readonly _tag: "HealthCheckPassed" }
  | { readonly _tag: "HealthCheckFailed" }
  | { readonly _tag: "ProcessExited"; readonly exitCode: number }
  | { readonly _tag: "StopRequested" }
  | {
      readonly _tag: "RestartTriggered";
      readonly restartCount: number;
    }
  | { readonly _tag: "BackoffElapsed" }
  | { readonly _tag: "HookFailed"; readonly error: string };

// ---------------------------------------------------------------------------
// Transition table — set of (fromStatus, eventTag) pairs that are legal
// ---------------------------------------------------------------------------

const allowed = new Set<`${ServiceStatus}:${ServiceEvent["_tag"]}`>([
  "Pending:DependenciesSatisfied",
  "Pending:DependencyFailed",
  "Pending:StopRequested",
  "Starting:ProcessSpawned",
  "Starting:StopRequested",
  "Running:HealthCheckPassed",
  "Running:ProcessExited",
  "Running:StopRequested",
  "Healthy:HealthCheckPassed",
  "Healthy:HealthCheckFailed",
  "Healthy:ProcessExited",
  "Healthy:StopRequested",
  "Unhealthy:HealthCheckPassed",
  "Unhealthy:ProcessExited",
  "Unhealthy:StopRequested",
  "Stopping:ProcessExited",
  "Stopped:RestartTriggered",
  "Failed:RestartTriggered",
  "Unhealthy:RestartTriggered",
  "Restarting:StopRequested",
  "Restarting:BackoffElapsed",
  "Running:HookFailed",
  "Healthy:HookFailed",
]);

// ---------------------------------------------------------------------------
// applyEvent — pure function, returns new ServiceState or null if invalid
// ---------------------------------------------------------------------------

export const applyEvent = (state: ServiceState, event: ServiceEvent): ServiceState | null => {
  const key = `${state.status}:${event._tag}` as const;
  if (!allowed.has(key)) return null;

  switch (event._tag) {
    case "DependenciesSatisfied":
      return new ServiceState({ ...state, status: "Starting" });

    case "DependencyFailed":
      return new ServiceState({
        ...state,
        status: "Failed",
        error: event.error,
      });

    case "ProcessSpawned":
      return new ServiceState({
        ...state,
        status: "Running",
        pid: event.pid,
        startedAt: event.startedAt,
      });

    case "HealthCheckPassed":
      return new ServiceState({ ...state, status: "Healthy" });

    case "HealthCheckFailed":
      return new ServiceState({ ...state, status: "Unhealthy" });

    case "ProcessExited": {
      const status: ServiceStatus =
        state.status === "Stopping" ? "Stopped" : event.exitCode === 0 ? "Stopped" : "Failed";
      return new ServiceState({
        ...state,
        status,
        exitCode: event.exitCode,
      });
    }

    case "StopRequested": {
      // Pending/Restarting have no running process — go straight to Stopped
      const stopStatus =
        state.status === "Pending" || state.status === "Restarting" ? "Stopped" : "Stopping";
      return new ServiceState({ ...state, status: stopStatus });
    }

    case "RestartTriggered":
      return new ServiceState({
        ...state,
        status: "Restarting",
        restartCount: event.restartCount,
      });

    case "BackoffElapsed":
      return new ServiceState({
        ...state,
        status: "Starting",
        pid: null,
        exitCode: null,
        startedAt: null,
        error: null,
      });

    case "HookFailed":
      return new ServiceState({
        ...state,
        status: "Failed",
        error: event.error,
      });
  }
};

// ---------------------------------------------------------------------------
// transition — effectful, atomic validate-and-apply via SubscriptionRef
// ---------------------------------------------------------------------------

export const transition = (
  ref: SubscriptionRef.SubscriptionRef<ServiceState>,
  event: ServiceEvent,
): Effect.Effect<ServiceState | null> =>
  SubscriptionRef.modifyEffect(ref, (current) => {
    const next = applyEvent(current, event);
    if (next === null) return Effect.succeed([null, current] as const);
    return Effect.succeed([next, next] as const);
  });

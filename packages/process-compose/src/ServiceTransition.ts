import { Effect, Match, SubscriptionRef } from "effect";
import { ServiceState, type ServiceStatus } from "./ServiceState.ts";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ServiceEvent =
  | { readonly _tag: "DependenciesSatisfied" }
  | { readonly _tag: "DependencyFailed"; readonly error: string }
  | { readonly _tag: "SpawnFailed"; readonly error: string }
  | {
      readonly _tag: "ProcessSpawned";
      readonly pid: number;
      readonly startedAt: number;
    }
  | { readonly _tag: "HealthCheckPassed" }
  | { readonly _tag: "HealthCheckFailed" }
  | { readonly _tag: "ProcessTerminated" }
  | { readonly _tag: "UnhealthyRestartExhausted"; readonly error: string }
  | { readonly _tag: "ProcessExited"; readonly exitCode: number }
  | { readonly _tag: "StopRequested" }
  | {
      readonly _tag: "RestartTriggered";
      readonly restartCount: number;
    }
  | { readonly _tag: "BackoffElapsed" }
  | { readonly _tag: "HookFailed"; readonly error: string };

// ---------------------------------------------------------------------------
// Transition table — every event must classify its legal source statuses
// ---------------------------------------------------------------------------

const transitionSets = {
  dependenciesSatisfied: new Set<ServiceStatus>(["Pending"]),
  spawnFailed: new Set<ServiceStatus>(["Pending", "Starting", "Restarting"]),
  processSpawned: new Set<ServiceStatus>(["Starting"]),
  healthCheckPassed: new Set<ServiceStatus>(["Running", "Healthy", "Unhealthy"]),
  healthCheckFailed: new Set<ServiceStatus>(["Running", "Healthy"]),
  unhealthy: new Set<ServiceStatus>(["Unhealthy"]),
  processExited: new Set<ServiceStatus>(["Running", "Healthy", "Unhealthy", "Stopping", "Failed"]),
  stopRequested: new Set<ServiceStatus>([
    "Pending",
    "Starting",
    "Running",
    "Healthy",
    "Unhealthy",
    "Restarting",
    "Failed",
  ]),
  restartTriggered: new Set<ServiceStatus>(["Stopped", "Failed", "Unhealthy"]),
  backoffElapsed: new Set<ServiceStatus>(["Restarting"]),
  hookFailed: new Set<ServiceStatus>(["Starting", "Running", "Healthy", "Unhealthy"]),
} as const;

const transitionStatuses = Match.type<ServiceEvent>().pipe(
  Match.tag(
    "DependenciesSatisfied",
    "DependencyFailed",
    () => transitionSets.dependenciesSatisfied,
  ),
  Match.tag("SpawnFailed", () => transitionSets.spawnFailed),
  Match.tag("ProcessSpawned", () => transitionSets.processSpawned),
  Match.tag("HealthCheckPassed", () => transitionSets.healthCheckPassed),
  Match.tag("HealthCheckFailed", () => transitionSets.healthCheckFailed),
  Match.tag("ProcessTerminated", "UnhealthyRestartExhausted", () => transitionSets.unhealthy),
  Match.tag("ProcessExited", () => transitionSets.processExited),
  Match.tag("StopRequested", () => transitionSets.stopRequested),
  Match.tag("RestartTriggered", () => transitionSets.restartTriggered),
  Match.tag("BackoffElapsed", () => transitionSets.backoffElapsed),
  Match.tag("HookFailed", () => transitionSets.hookFailed),
  Match.exhaustive,
);

const applyTransition = Match.type<ServiceEvent>().pipe(
  Match.tag(
    "DependenciesSatisfied",
    () => (state: ServiceState) => new ServiceState({ ...state, status: "Starting" }),
  ),
  Match.tag(
    "DependencyFailed",
    "SpawnFailed",
    (event) => (state: ServiceState) =>
      new ServiceState({
        ...state,
        status: "Failed",
        pid: null,
        exitCode: null,
        error: event.error,
      }),
  ),
  Match.tag(
    "ProcessSpawned",
    (event) => (state: ServiceState) =>
      new ServiceState({
        ...state,
        status: "Running",
        pid: event.pid,
        startedAt: event.startedAt,
      }),
  ),
  Match.tag(
    "HealthCheckPassed",
    () => (state: ServiceState) => new ServiceState({ ...state, status: "Healthy" }),
  ),
  Match.tag(
    "HealthCheckFailed",
    () => (state: ServiceState) => new ServiceState({ ...state, status: "Unhealthy" }),
  ),
  Match.tag(
    "ProcessTerminated",
    () => (state: ServiceState) => new ServiceState({ ...state, pid: null }),
  ),
  Match.tag(
    "UnhealthyRestartExhausted",
    (event) => (state: ServiceState) =>
      new ServiceState({
        ...state,
        status: "Failed",
        pid: null,
        exitCode: null,
        error: event.error,
      }),
  ),
  Match.tag("ProcessExited", (event) => (state: ServiceState) => {
    const status: ServiceStatus =
      state.status === "Stopping" ? "Stopped" : event.exitCode === 0 ? "Stopped" : "Failed";
    return new ServiceState({ ...state, status, pid: null, exitCode: event.exitCode });
  }),
  Match.tag("StopRequested", () => (state: ServiceState) => {
    const stopStatus =
      state.status === "Pending" || state.status === "Restarting" ? "Stopped" : "Stopping";
    return new ServiceState({ ...state, status: stopStatus });
  }),
  Match.tag(
    "RestartTriggered",
    (event) => (state: ServiceState) =>
      new ServiceState({
        ...state,
        status: "Restarting",
        pid: null,
        restartCount: event.restartCount,
      }),
  ),
  Match.tag(
    "BackoffElapsed",
    () => (state: ServiceState) =>
      new ServiceState({
        ...state,
        status: "Starting",
        pid: null,
        exitCode: null,
        startedAt: null,
        error: null,
      }),
  ),
  Match.tag(
    "HookFailed",
    (event) => (state: ServiceState) =>
      new ServiceState({ ...state, status: "Failed", pid: null, error: event.error }),
  ),
  Match.exhaustive,
);

// ---------------------------------------------------------------------------
// applyEvent — pure function, returns new ServiceState or null if invalid
// ---------------------------------------------------------------------------

export const applyEvent = (state: ServiceState, event: ServiceEvent): ServiceState | null => {
  if (!transitionStatuses(event).has(state.status)) return null;
  return applyTransition(event)(state);
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

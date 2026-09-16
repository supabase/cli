import { Cause, Deferred, Exit, Fiber, Match, Predicate } from "effect";
import type { ActivationResult } from "../gateway/Gateway.ts";
import type { StackId } from "../public/StackId.ts";
import {
  GatewayActivationError,
  StackLifecycleConflictError,
  StackNotRunningError,
  type GatewayActivationError as GatewayActivationErrorType,
  type StackError,
} from "../public/Errors.ts";
import type { CleanupOutcome, LifecycleInput } from "./Lifecycle.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import {
  dependencyClosure,
  eagerCapabilities,
  type ExecutionPlan,
} from "../model/ExecutionPlan.ts";
import {
  beginStarting,
  beginStopping,
  cleanupFailed,
  completeStarting,
  dormant,
  dormantFromReady,
  promoteStartingPrior,
  ready,
  restoreStarting,
  type CapabilityState,
} from "./CapabilityState.ts";
import {
  isTransitioning,
  type LifecycleKind,
  recoveryForState,
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

export type TransitionNotification =
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
      readonly _tag: "stopping";
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly result: Exit.Exit<void, StackError>;
    }
  | {
      readonly _tag: "lifecycle";
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly result: Exit.Exit<void, StackError>;
    }
  | {
      readonly _tag: "workload";
      readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
      readonly result: Exit.Exit<void, StackError>;
    };

export type SnapshotTransition = Readonly<{
  readonly snapshot: SupervisorSnapshot;
  readonly notifications: ReadonlyArray<TransitionNotification>;
  readonly reconcile: "all-ready" | "none";
}>;

type TransitionState =
  | Extract<StackControlState, { readonly _tag: "starting" }>
  | Extract<StackControlState, { readonly _tag: "stopping" }>
  | Extract<StackControlState, { readonly _tag: "destroying" }>;

export type LifecycleAdmission =
  | (SnapshotTransition & { readonly _tag: "accepted" })
  | {
      readonly _tag: "rejected";
      readonly reason: LifecycleAdmissionReason;
      readonly activeKind?: LifecycleKind;
    };

type LifecycleAdmissionReason = "lifecycle-transition" | "stop-required" | "destroy-required";

/** Projects control state into the phase visible to the supervisor and public projection. */
export const publicPhase = (
  state: StackControlState,
): "stopped" | "starting" | "running" | "stopping" | "destroying" => {
  return Match.value(state).pipe(
    Match.when({ _tag: "stopped" }, () => "stopped" as const),
    Match.when({ _tag: "running" }, () => "running" as const),
    Match.when({ _tag: "starting", prior: { _tag: "running" } }, () => "running" as const),
    Match.when({ _tag: "starting" }, () => "starting" as const),
    Match.tag("stopping", "start-recovery", "stop-required", () => "stopping" as const),
    Match.tag("destroying", "destroy-required", () => "destroying" as const),
    Match.exhaustive,
  );
};

export type ActiveLifecycle = Readonly<{
  readonly kind: LifecycleKind;
  readonly result: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
}>;

export const activeLifecycle = (state: StackControlState): ActiveLifecycle | undefined =>
  Match.value(state).pipe(
    Match.tag("starting", "start-recovery", (value) => ({
      kind: "start" as const,
      result: value.completion,
    })),
    Match.tag("stopping", (value) => ({ kind: "stop" as const, result: value.completion })),
    Match.tag("destroying", (value) => ({ kind: "destroy" as const, result: value.completion })),
    Match.tag("stopped", "running", "stop-required", "destroy-required", () => undefined),
    Match.exhaustive,
  );

/** Decides lifecycle admission once while the supervisor admission permit is held. */
export const admitLifecycle = (
  snapshot: SupervisorSnapshot,
  kind: LifecycleKind,
  completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>,
  attempt: symbol,
): LifecycleAdmission => {
  const state = snapshot.stack;
  const activeKind = activeLifecycle(state)?.kind;
  const rejected = (reason: LifecycleAdmissionReason): LifecycleAdmission => ({
    _tag: "rejected",
    reason,
    ...(activeKind === undefined ? {} : { activeKind }),
  });
  const accepted = (next: TransitionState): LifecycleAdmission => ({
    _tag: "accepted",
    snapshot: { ...snapshot, stack: next },
    notifications: [],
    reconcile: "none",
  });
  return Match.value(kind).pipe(
    Match.when("start", () =>
      Match.value(state).pipe(
        Match.tag("stopped", "running", (prior) =>
          accepted({ _tag: "starting", attempt, completion, prior }),
        ),
        Match.tag("stop-required", () => rejected("stop-required")),
        Match.tag("destroy-required", () => rejected("destroy-required")),
        Match.tag("starting", "start-recovery", "stopping", "destroying", () =>
          rejected("lifecycle-transition"),
        ),
        Match.exhaustive,
      ),
    ),
    Match.when("stop", () =>
      Match.value(state).pipe(
        Match.tag("stopped", "running", "stop-required", (prior) =>
          accepted({ _tag: "stopping", attempt, completion, prior }),
        ),
        Match.tag("destroy-required", () => rejected("destroy-required")),
        Match.tag("starting", "start-recovery", "stopping", "destroying", () =>
          rejected("lifecycle-transition"),
        ),
        Match.exhaustive,
      ),
    ),
    Match.when("destroy", () =>
      Match.value(state).pipe(
        Match.tag("stopped", "running", "stop-required", "destroy-required", (prior) =>
          accepted({ _tag: "destroying", attempt, completion, prior }),
        ),
        Match.tag("starting", "start-recovery", "stopping", "destroying", () =>
          rejected("lifecycle-transition"),
        ),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};

export type ActivationToken =
  | { readonly _tag: "exit"; readonly result: ActivationExit }
  | { readonly _tag: "deferred"; readonly result: Deferred.Deferred<ActivationExit, never> }
  | {
      readonly _tag: "endpoint";
      readonly capability: CapabilityName;
      readonly result: Deferred.Deferred<EndpointExit, never>;
    }
  | {
      readonly _tag: "await";
      readonly result: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
    };

export type ActivationDecision =
  | { readonly _tag: "respond"; readonly token: ActivationToken }
  | {
      readonly _tag: "endpoint-owner";
      readonly owner: Extract<ActivationOwner, { readonly _tag: "endpoint" }>;
      readonly snapshot: SnapshotTransition;
    }
  | {
      readonly _tag: "activation-owner";
      readonly owner: Extract<ActivationOwner, { readonly _tag: "activation" }>;
      readonly snapshot: SnapshotTransition;
    }
  | { readonly _tag: "rejected"; readonly error: GatewayActivationErrorType | StackError };

export type ActivationGate =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "rejected"; readonly error: GatewayActivationErrorType | StackError };

export const activationGate = (snapshot: SupervisorSnapshot, stackId: StackId): ActivationGate => {
  const inProgress = (kind: LifecycleKind): ActivationGate => ({
    _tag: "rejected",
    error: new StackLifecycleConflictError({
      stackId,
      message: `Cannot activate while ${kind} is in progress`,
    }),
  });
  return Match.value(snapshot.stack).pipe(
    Match.when({ _tag: "running" }, () => ({ _tag: "accepted" as const })),
    Match.when({ _tag: "stopped" }, () => ({
      _tag: "rejected" as const,
      error: new StackNotRunningError({ message: "Stack must be running before activation" }),
    })),
    Match.when({ _tag: "starting" }, () => inProgress("start")),
    Match.when({ _tag: "stopping" }, () => inProgress("stop")),
    Match.when({ _tag: "destroying" }, () => inProgress("destroy")),
    Match.when({ _tag: "stop-required" }, (state) => ({
      _tag: "rejected" as const,
      error: new StackLifecycleConflictError({
        stackId,
        message: "Exact runtime cleanup is required; retry stop before activating",
        recovery: recoveryForState(state),
      }),
    })),
    Match.when({ _tag: "start-recovery" }, () => inProgress("start")),
    Match.when({ _tag: "destroy-required" }, (state) => ({
      _tag: "rejected" as const,
      error: new StackLifecycleConflictError({
        stackId,
        message: "Destructive cleanup is required; retry destroy before activating",
        recovery: recoveryForState(state),
      }),
    })),
    Match.exhaustive,
  );
};

export const admitActivation = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
  stackId: StackId,
  endpoint: Deferred.Deferred<EndpointExit, never>,
  activation: Deferred.Deferred<ActivationExit, never>,
  operation: symbol,
): ActivationDecision => {
  const gate = activationGate(snapshot, stackId);
  if (Predicate.isTagged(gate, "rejected")) return gate;
  const current = snapshot.capabilities.get(capability);
  if (current === undefined)
    return {
      _tag: "rejected",
      error: new GatewayActivationError({
        message: `Capability ${capability} is unavailable in this session`,
      }),
    };
  return Match.value(current).pipe(
    Match.tag("disabled", () => ({
      _tag: "rejected" as const,
      error: new GatewayActivationError({ message: `Capability ${capability} is not enabled` }),
    })),
    Match.tag("stopped", () => ({
      _tag: "rejected" as const,
      error: new StackNotRunningError({ message: "Stack must be running before activation" }),
    })),
    Match.tag("cleanup-failed", () => ({
      _tag: "rejected" as const,
      error: new StackLifecycleConflictError({
        stackId,
        message: `Capability ${capability} cleanup failed; retry stop before activating`,
      }),
    })),
    Match.tag("starting", (state) =>
      Match.value(state.completion).pipe(
        Match.tag("activation", (completion) => ({
          _tag: "respond" as const,
          token: { _tag: "deferred" as const, result: completion.deferred },
        })),
        Match.tag("workload", (completion) => ({
          _tag: "respond" as const,
          token: { _tag: "await" as const, result: completion.deferred },
        })),
        Match.exhaustive,
      ),
    ),
    Match.tag("stopping", (state) => ({
      _tag: "respond" as const,
      token: { _tag: "await" as const, result: state.completion },
    })),
    Match.tag("ready", (state) =>
      Match.value(state.endpoint).pipe(
        Match.tag("resolved", (endpointState) => ({
          _tag: "respond" as const,
          token: {
            _tag: "exit" as const,
            result: Exit.succeed({ capability, endpoint: endpointState.endpoint }),
          },
        })),
        Match.tag("resolving", (endpointState) => ({
          _tag: "respond" as const,
          token: { _tag: "endpoint" as const, capability, result: endpointState.deferred },
        })),
        Match.tag("unresolved", () => ({
          _tag: "endpoint-owner" as const,
          owner: { _tag: "endpoint" as const, capability, endpoint, priorRoot: state.root },
          snapshot: {
            snapshot: beginEndpointResolution(snapshot, capability, endpoint),
            notifications: [],
            reconcile: "none" as const,
          },
        })),
        Match.exhaustive,
      ),
    ),
    Match.tag("dormant", (state) => ({
      _tag: "activation-owner" as const,
      owner: { _tag: "activation" as const, capability, completion: activation },
      snapshot: {
        snapshot: beginActivation(snapshot, capability, state, operation, activation),
        notifications: [],
        reconcile: "none" as const,
      },
    })),
    Match.exhaustive,
  );
};

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
export type ActivationClaims =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "claimed";
      readonly claimed: ReadonlyArray<ClaimedWorkload>;
      readonly affected: ReadonlySet<CapabilityName>;
    };
export type ActivationTerminalOutcome =
  | { readonly _tag: "succeeded"; readonly value: ActivationResult }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<StackError>;
      readonly cleanup: CleanupOutcome;
    };
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
export type SettlementOwner = RetirementOwner | LifecycleOwner;

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

export type StartupHandle = Readonly<{
  readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
  readonly operation: symbol;
}>;

export const initializeSession = (
  snapshot: SupervisorSnapshot,
  input: LifecycleInput,
  sessionId: symbol,
  startup: ReadonlyMap<CapabilityName, StartupHandle>,
): SnapshotTransition => {
  const roots = new Set(
    CAPABILITY_NAMES.filter(
      (name) =>
        input.definition.capabilities[name].enabled && input.plan.activation[name] === "eager",
    ),
  );
  const eager = eagerCapabilities(input.plan);
  const capabilities = new Map<CapabilityName, CapabilityState>();
  for (const name of CAPABILITY_NAMES) {
    const configured = input.definition.capabilities[name];
    const handle = startup.get(name);
    if (!configured.enabled) capabilities.set(name, { _tag: "disabled" });
    else if (eager.has(name) && handle !== undefined)
      capabilities.set(
        name,
        beginStarting(
          dormant(sessionId),
          handle.operation,
          { _tag: "workload", deferred: handle.completion },
          roots.has(name),
        ),
      );
    else capabilities.set(name, dormant(sessionId));
  }
  return {
    snapshot: { ...snapshot, sessionId, plan: input.plan, capabilities },
    notifications: [],
    reconcile: "none",
  };
};

export const readySet = (
  snapshot: SupervisorSnapshot,
  names: ReadonlySet<CapabilityName>,
): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  const notifications: Array<TransitionNotification> = [];
  for (const [name, state] of capabilities) {
    if (Predicate.isTagged(state, "dormant") && names.has(name))
      capabilities.set(name, ready(state.sessionId, state.traffic, state.root));
    else if (
      Predicate.isTagged(state, "starting") &&
      Predicate.isTagged(state.completion, "workload") &&
      names.has(name)
    ) {
      notifications.push({
        _tag: "workload",
        completion: state.completion.deferred,
        result: Exit.void,
      });
      capabilities.set(name, completeStarting(state));
    }
  }
  return { snapshot: { ...snapshot, capabilities }, notifications, reconcile: "none" };
};

export const promoteActivationSet = (
  snapshot: SupervisorSnapshot,
  names: ReadonlySet<CapabilityName>,
  activationOwner: CapabilityName,
  plan: ExecutionPlan,
): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  for (const name of names) {
    const state = capabilities.get(name);
    if (
      name !== activationOwner &&
      Predicate.isTagged(state, "starting") &&
      Predicate.isTagged(state.completion, "activation")
    )
      capabilities.set(name, promoteStartingPrior(state));
  }
  return {
    snapshot: { ...snapshot, plan, capabilities },
    notifications: [],
    reconcile: "none",
  };
};

export type ClaimedWorkload = Readonly<{
  readonly name: CapabilityName;
  readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
  readonly prior: Extract<CapabilityState, { readonly _tag: "dormant" }>;
}>;

export const claimWorkloads = (
  snapshot: SupervisorSnapshot,
  names: ReadonlySet<CapabilityName>,
  handles: ReadonlyMap<CapabilityName, StartupHandle>,
): SnapshotTransition & { readonly claimed: ReadonlyArray<ClaimedWorkload> } => {
  const capabilities = new Map(snapshot.capabilities);
  const claimed: Array<ClaimedWorkload> = [];
  for (const name of names) {
    const current = capabilities.get(name);
    const handle = handles.get(name);
    if (!Predicate.isTagged(current, "dormant") || handle === undefined) continue;
    claimed.push({ name, completion: handle.completion, prior: current });
    capabilities.set(
      name,
      beginStarting(current, handle.operation, {
        _tag: "workload",
        deferred: handle.completion,
      }),
    );
  }
  return {
    snapshot: { ...snapshot, capabilities },
    claimed,
    notifications: [],
    reconcile: "none",
  };
};

const beginEndpointResolution = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
  endpoint: Deferred.Deferred<EndpointExit, never>,
): SupervisorSnapshot => {
  const current = snapshot.capabilities.get(capability);
  if (!Predicate.isTagged(current, "ready")) return snapshot;
  return {
    ...snapshot,
    capabilities: new Map(snapshot.capabilities).set(capability, {
      ...current,
      root: true,
      endpoint: { _tag: "resolving", deferred: endpoint },
    }),
  };
};

const beginActivation = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
  prior: Extract<CapabilityState, { readonly _tag: "dormant" }>,
  operation: symbol,
  completion: Deferred.Deferred<ActivationExit, never>,
): SupervisorSnapshot => ({
  ...snapshot,
  capabilities: new Map(snapshot.capabilities).set(
    capability,
    beginStarting(prior, operation, { _tag: "activation", deferred: completion }, true),
  ),
});

export const setRootSet = (
  snapshot: SupervisorSnapshot,
  names: ReadonlySet<CapabilityName>,
): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  for (const [name, state] of capabilities)
    capabilities.set(
      name,
      Match.value(state).pipe(
        Match.tag("disabled", "stopped", (value) => value),
        Match.tag("dormant", "starting", "ready", "stopping", "cleanup-failed", (value) => ({
          ...value,
          root: names.has(name),
        })),
        Match.exhaustive,
      ),
    );
  return { snapshot: { ...snapshot, capabilities }, notifications: [], reconcile: "none" };
};

export type TrafficTransition = SnapshotTransition &
  Readonly<{
    readonly timer: Fiber.Fiber<void, unknown> | undefined;
    readonly shouldArm: boolean;
  }>;

export const beginTraffic = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
): TrafficTransition => {
  const current = snapshot.capabilities.get(capability);
  const timer =
    Predicate.isTagged(current, "ready") && Predicate.isTagged(current.retirement, "armed")
      ? current.retirement.fiber
      : undefined;
  if (Predicate.isTagged(current, "ready")) {
    const next = {
      ...current,
      traffic: current.traffic + 1,
      retirement: { _tag: "disarmed" as const },
    };
    return {
      snapshot: { ...snapshot, capabilities: new Map(snapshot.capabilities).set(capability, next) },
      notifications: [],
      reconcile: "none",
      timer,
      shouldArm: false,
    };
  }
  if (
    Predicate.isTagged(current, "dormant") ||
    Predicate.isTagged(current, "starting") ||
    Predicate.isTagged(current, "stopping") ||
    Predicate.isTagged(current, "cleanup-failed")
  ) {
    const next = { ...current, traffic: current.traffic + 1 };
    return {
      snapshot: { ...snapshot, capabilities: new Map(snapshot.capabilities).set(capability, next) },
      notifications: [],
      reconcile: "none",
      timer: undefined,
      shouldArm: false,
    };
  }
  return { snapshot, notifications: [], reconcile: "none", timer: undefined, shouldArm: false };
};

export const endTraffic = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
  sessionId: symbol,
): TrafficTransition => {
  if (snapshot.sessionId !== sessionId)
    return { snapshot, notifications: [], reconcile: "none", timer: undefined, shouldArm: false };
  const current = snapshot.capabilities.get(capability);
  if (
    !Predicate.isTagged(current, "dormant") &&
    !Predicate.isTagged(current, "starting") &&
    !Predicate.isTagged(current, "ready") &&
    !Predicate.isTagged(current, "stopping") &&
    !Predicate.isTagged(current, "cleanup-failed")
  )
    return { snapshot, notifications: [], reconcile: "none", timer: undefined, shouldArm: false };
  const next = { ...current, traffic: Math.max(0, current.traffic - 1) };
  return {
    snapshot: { ...snapshot, capabilities: new Map(snapshot.capabilities).set(capability, next) },
    notifications: [],
    reconcile: "none",
    timer: undefined,
    shouldArm: current.traffic <= 1,
  };
};

const canRetire = (
  plan: ExecutionPlan,
  roots: ReadonlySet<CapabilityName>,
  capability: CapabilityName,
): boolean =>
  ![...roots].some(
    (root) => root !== capability && dependencyClosure(plan, [root]).has(capability),
  );

const rootSet = (snapshot: SupervisorSnapshot): ReadonlySet<CapabilityName> =>
  new Set(
    [...snapshot.capabilities].flatMap(([name, state]) =>
      "root" in state && state.root ? [name] : [],
    ),
  );

const idleTimeout = (
  timeouts: ReadonlyMap<CapabilityName, number | false>,
  plan: ExecutionPlan,
  capability: CapabilityName,
): number | false =>
  plan.activation[capability] === "lazy" ? (timeouts.get(capability) ?? false) : false;

type IdleCandidate = Readonly<{
  readonly capability: CapabilityName;
  readonly plan: ExecutionPlan;
  readonly state: Extract<CapabilityState, { readonly _tag: "ready" }>;
}>;

const idleCandidate = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
): IdleCandidate | undefined => {
  if (!Predicate.isTagged(snapshot.stack, "running")) return undefined;
  const plan = snapshot.plan;
  const state = snapshot.capabilities.get(capability);
  if (plan === undefined || !Predicate.isTagged(state, "ready") || state.traffic !== 0)
    return undefined;
  return canRetire(plan, rootSet(snapshot), capability) ? { capability, plan, state } : undefined;
};

export type IdleTimerPlan = IdleCandidate & Readonly<{ readonly timeout: number }>;

export const planIdleTimer = (
  snapshot: SupervisorSnapshot,
  timeouts: ReadonlyMap<CapabilityName, number | false>,
  capability: CapabilityName,
): IdleTimerPlan | undefined => {
  const candidate = idleCandidate(snapshot, capability);
  if (candidate === undefined || !Predicate.isTagged(candidate.state.retirement, "disarmed"))
    return undefined;
  const timeout = idleTimeout(timeouts, candidate.plan, capability);
  return timeout === false ? undefined : { ...candidate, timeout };
};

export const beginRetirement = (
  snapshot: SupervisorSnapshot,
  capability: CapabilityName,
  operation: symbol,
  completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>,
  epoch: symbol,
): SnapshotTransition & { readonly admitted: boolean } => {
  const candidate = idleCandidate(snapshot, capability);
  const current = snapshot.capabilities.get(capability);
  if (
    candidate === undefined ||
    !Predicate.isTagged(candidate.state.retirement, "armed") ||
    candidate.state.retirement.epoch !== epoch
  ) {
    if (
      Predicate.isTagged(current, "ready") &&
      Predicate.isTagged(current.retirement, "armed") &&
      current.retirement.epoch === epoch
    ) {
      return {
        snapshot: {
          ...snapshot,
          capabilities: new Map(snapshot.capabilities).set(capability, {
            ...current,
            retirement: { _tag: "disarmed" },
          }),
        },
        notifications: [],
        reconcile: "none",
        admitted: false,
      };
    }
    return { snapshot, notifications: [], reconcile: "none", admitted: false };
  }
  return {
    snapshot: {
      ...snapshot,
      capabilities: new Map(snapshot.capabilities).set(
        capability,
        beginStopping(candidate.state, operation, completion, false),
      ),
    },
    notifications: [],
    reconcile: "none",
    admitted: true,
  };
};

export const armRetirement = (
  snapshot: SupervisorSnapshot,
  plan: IdleTimerPlan,
  epoch: symbol,
  fiber: Fiber.Fiber<void, unknown>,
): SnapshotTransition => {
  return {
    snapshot: {
      ...snapshot,
      capabilities: new Map(snapshot.capabilities).set(plan.capability, {
        ...plan.state,
        retirement: { _tag: "armed", epoch, fiber },
      }),
    },
    notifications: [],
    reconcile: "none",
  };
};

export const disarmAllRetirements = (
  snapshot: SupervisorSnapshot,
): SnapshotTransition & { readonly timers: ReadonlyArray<Fiber.Fiber<void, unknown>> } => {
  const timers: Array<Fiber.Fiber<void, unknown>> = [];
  const capabilities = new Map(snapshot.capabilities);
  for (const [name, state] of capabilities)
    if (Predicate.isTagged(state, "ready") && Predicate.isTagged(state.retirement, "armed")) {
      timers.push(state.retirement.fiber);
      capabilities.set(name, { ...state, retirement: { _tag: "disarmed" } });
    }
  return {
    snapshot: { ...snapshot, capabilities },
    notifications: [],
    reconcile: "none",
    timers,
  };
};

export type CleanupHandle = Readonly<{
  readonly operation: symbol;
  readonly completion: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
}>;

export const enterCapabilityCleanup = (
  snapshot: SupervisorSnapshot,
  handles: ReadonlyMap<CapabilityName, CleanupHandle>,
): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  for (const [name, state] of capabilities) {
    const handle = handles.get(name);
    if (
      handle !== undefined &&
      (Predicate.isTagged(state, "ready") || Predicate.isTagged(state, "cleanup-failed"))
    )
      capabilities.set(name, beginStopping(state, handle.operation, handle.completion));
  }
  return { snapshot: { ...snapshot, capabilities }, notifications: [], reconcile: "none" };
};

export const settleCapabilityCleanup = (
  snapshot: SupervisorSnapshot,
  result: Exit.Exit<void, StackError>,
  handles: ReadonlyMap<CapabilityName, CleanupHandle>,
): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  const notifications: Array<TransitionNotification> = [];
  for (const [name, state] of capabilities) {
    if (!Predicate.isTagged(state, "stopping")) continue;
    const handle = handles.get(name);
    if (
      handle === undefined ||
      handle.operation !== state.operation ||
      handle.completion !== state.completion
    )
      continue;
    capabilities.set(
      name,
      Exit.isSuccess(result) ? { _tag: "stopped" } : cleanupFailed(state, result.cause),
    );
    notifications.push({ _tag: "stopping", completion: state.completion, result });
  }
  return { snapshot: { ...snapshot, capabilities }, notifications, reconcile: "none" };
};

export const completeDormantCleanup = (snapshot: SupervisorSnapshot): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  for (const [name, state] of capabilities)
    if (Predicate.isTagged(state, "dormant")) capabilities.set(name, { _tag: "stopped" });
  return { snapshot: { ...snapshot, capabilities }, notifications: [], reconcile: "none" };
};

const settleStartingCapabilities = (
  snapshot: SupervisorSnapshot,
  cause: Cause.Cause<StackError>,
  cleanup: CleanupOutcome,
  durable: "stopped" | "unsafe",
): SnapshotTransition => {
  const capabilities = new Map(snapshot.capabilities);
  const result = Exit.failCause(cause);
  const notifications: Array<TransitionNotification> = [];
  for (const [name, state] of capabilities) {
    if (!Predicate.isTagged(state, "starting") || !Predicate.isTagged(state.completion, "workload"))
      continue;
    capabilities.set(
      name,
      Predicate.isTagged(cleanup, "proven")
        ? durable === "stopped"
          ? { _tag: "stopped" }
          : state.prior
        : cleanupFailed(state, cause),
    );
    notifications.push({ _tag: "workload", completion: state.completion.deferred, result });
  }
  return { snapshot: { ...snapshot, capabilities }, notifications, reconcile: "none" };
};

/** Applies one activation terminal event, including claims, roots and owner completion. */
export const settleActivationTerminal = (
  snapshot: SupervisorSnapshot,
  owner: ActivationOwner,
  claims: ActivationClaims,
  outcome: ActivationTerminalOutcome,
): SnapshotTransition => {
  const failed = Predicate.isTagged(outcome, "failed");
  const result = failed ? Exit.failCause(outcome.cause) : Exit.void;
  const ownerMatches = matchesActivationOwner(snapshot, owner);
  const notification: TransitionNotification = Predicate.isTagged(owner, "endpoint")
    ? {
        _tag: "endpoint",
        completion: owner.endpoint,
        result: !failed ? Exit.succeed(outcome.value.endpoint) : Exit.failCause(outcome.cause),
      }
    : {
        _tag: "activation",
        completion: owner.completion,
        result: !failed ? Exit.succeed(outcome.value) : Exit.failCause(outcome.cause),
      };
  if (!ownerMatches) return { snapshot, notifications: [notification], reconcile: "all-ready" };

  const cleanup = failed ? outcome.cleanup : { _tag: "proven" as const };
  const claimed = Predicate.isTagged(claims, "claimed") ? claims.claimed : [];
  const affected = Predicate.isTagged(claims, "claimed")
    ? claims.affected
    : new Set<CapabilityName>();
  const capabilities = new Map(snapshot.capabilities);
  const notifications: Array<TransitionNotification> = [];
  let mutated = false;
  if (failed) {
    for (const entry of claimed) {
      const current = capabilities.get(entry.name);
      if (
        Predicate.isTagged(current, "starting") &&
        Predicate.isTagged(current.completion, "workload") &&
        current.completion.deferred === entry.completion
      ) {
        mutated = true;
        capabilities.set(
          entry.name,
          Predicate.isTagged(cleanup, "unproven")
            ? cleanupFailed(current, cleanup.cause)
            : dormant(entry.prior.sessionId, current.traffic, entry.prior.root),
        );
        notifications.push({ _tag: "workload", completion: entry.completion, result });
      } else if (
        Predicate.isTagged(current, "ready") &&
        current.sessionId === entry.prior.sessionId
      ) {
        mutated = true;
        capabilities.set(
          entry.name,
          Predicate.isTagged(cleanup, "unproven")
            ? cleanupFailed(current, cleanup.cause)
            : dormantFromReady(current),
        );
      }
    }
    if (Predicate.isTagged(cleanup, "unproven"))
      for (const name of affected) {
        if (name === owner.capability) continue;
        const current = capabilities.get(name);
        if (
          !Predicate.isTagged(current, "starting") ||
          !Predicate.isTagged(current.completion, "activation")
        )
          continue;
        mutated = true;
        capabilities.set(name, cleanupFailed(current, cleanup.cause));
        notifications.push({
          _tag: "activation",
          completion: current.completion.deferred,
          result: Exit.failCause(cleanup.cause),
        });
      }
  }
  const current = capabilities.get(owner.capability);
  Match.value(owner).pipe(
    Match.tag("endpoint", (event) => {
      if (
        !Predicate.isTagged(current, "ready") ||
        !Predicate.isTagged(current.endpoint, "resolving")
      )
        return;
      capabilities.set(
        event.capability,
        failed
          ? { ...current, root: event.priorRoot, endpoint: { _tag: "unresolved" } }
          : { ...current, endpoint: { _tag: "resolved", endpoint: outcome.value.endpoint } },
      );
      mutated = true;
    }),
    Match.tag("activation", (event) => {
      if (
        !Predicate.isTagged(current, "starting") ||
        !Predicate.isTagged(current.completion, "activation")
      )
        return;
      capabilities.set(
        event.capability,
        failed
          ? Predicate.isTagged(cleanup, "unproven")
            ? cleanupFailed(current, cleanup.cause)
            : Predicate.isTagged(snapshot.stack, "stopped")
              ? { _tag: "stopped" }
              : restoreStarting(current)
          : completeStarting(current, { _tag: "resolved", endpoint: outcome.value.endpoint }, true),
      );
      mutated = true;
    }),
    Match.exhaustive,
  );
  const changed = mutated || (failed && Predicate.isTagged(cleanup, "unproven"));
  let next = !changed
    ? snapshot
    : failed && Predicate.isTagged(cleanup, "unproven")
      ? stopRecoverySnapshot({ ...snapshot, capabilities }, cleanup.cause)
      : { ...snapshot, capabilities };
  notifications.push(notification);
  return { snapshot: next, notifications, reconcile: "all-ready" };
};

const stopRecoverySnapshot = (
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

export const settleRetirementOwner = (
  snapshot: SupervisorSnapshot,
  owner: RetirementOwner,
): SnapshotTransition => {
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
        notifications: [
          {
            _tag: "stopping",
            completion: owner.completion,
            result: Exit.map(owner.result, () => undefined),
          },
        ],
        reconcile: "all-ready",
      };
    }
    if (Exit.isSuccess(owner.result))
      return {
        snapshot,
        notifications: [{ _tag: "stopping", completion: owner.completion, result: Exit.void }],
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
      notifications: [
        {
          _tag: "stopping",
          completion: owner.completion,
          result: Exit.failCause(owner.result.cause),
        },
      ],
      reconcile: "none",
    };
  }
  return {
    snapshot,
    notifications: [
      {
        _tag: "stopping",
        completion: owner.completion,
        result: Exit.isSuccess(owner.result) ? Exit.void : Exit.failCause(owner.result.cause),
      },
    ],
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
): SnapshotTransition => {
  const current = snapshot.stack;
  const operation = owner.result;
  const matches = isTransitioning(current) && current.completion === owner.completion;
  if (!matches)
    return {
      snapshot,
      notifications: [
        {
          _tag: "lifecycle",
          completion: owner.completion,
          result: commandResultExit(operation),
        },
      ],
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
  const startup =
    Predicate.isTagged(operation, "failed") &&
    (Predicate.isTagged(current, "starting") || Predicate.isTagged(current, "start-recovery"))
      ? settleStartingCapabilities(snapshot, operation.cause, operation.cleanup, operation.durable)
      : undefined;
  return {
    snapshot: {
      ...snapshot,
      stack: next,
      ...(startup === undefined ? {} : { capabilities: startup.snapshot.capabilities }),
    },
    notifications: [
      ...(startup?.notifications ?? []),
      { _tag: "lifecycle", completion: owner.completion, result: completion },
    ],
    reconcile: "all-ready",
  };
};

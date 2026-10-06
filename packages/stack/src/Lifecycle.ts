import { Data } from "effect";

const waiterCap = 256;
const breakerThreshold = 3;
const breakerCooldownMillis = 30_000;
/** Failures further apart than this are unrelated; it exceeds the cooldown so a reopened breaker keeps counting. */
const breakerWindowMillis = 300_000;
/** The pause between a failed re-check of a blocking session and the next one. */
const reprobeSpacingMillis = 1_000;

/** One member of the owner's composition graph, as the reducer needs to see it. */
export interface ServiceSpec {
  readonly id: string;
  readonly activation: "eager" | "lazy";
  readonly prerequisites: ReadonlyArray<string>;
  /** Undefined means the service never sleeps on idle. */
  readonly idleMillis?: number;
}

/**
 * The owner's composition graph, with its topological order precomputed, plus each service's
 * direct dependents (for the stop/restart guard), full transitive-dependent closure (every
 * service that needs it, directly or through another prerequisite, so a wake deep in a stopped
 * chain is visible to every ancestor in one pass) and full transitive prerequisite closure (so
 * readiness checks see a lost ancestor, not just a direct prerequisite).
 */
export interface LifecycleGraph {
  readonly services: ReadonlyMap<string, ServiceSpec>;
  readonly directDependents: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly transitiveDependents: ReadonlyMap<string, ReadonlySet<string>>;
  readonly prerequisiteClosure: ReadonlyMap<string, ReadonlySet<string>>;
  readonly order: ReadonlyArray<string>;
}

export const makeGraph = (specs: ReadonlyArray<ServiceSpec>): LifecycleGraph => {
  const services = new Map(specs.map((spec): [string, ServiceSpec] => [spec.id, spec]));
  const order: Array<string> = [];
  const seen = new Set<string>();
  const prerequisiteClosure = new Map<string, ReadonlySet<string>>();
  const closureOf = (id: string): ReadonlySet<string> => {
    const cached = prerequisiteClosure.get(id);
    if (cached !== undefined) return cached;
    const closure = new Set<string>();
    for (const prerequisite of services.get(id)?.prerequisites ?? []) {
      closure.add(prerequisite);
      for (const transitive of closureOf(prerequisite)) closure.add(transitive);
    }
    prerequisiteClosure.set(id, closure);
    return closure;
  };
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const prerequisite of services.get(id)?.prerequisites ?? []) visit(prerequisite);
    order.push(id);
  };
  const directDependents = new Map<string, Array<string>>();
  const transitiveDependents = new Map<string, Set<string>>();
  for (const id of services.keys()) {
    visit(id);
    for (const prerequisite of services.get(id)?.prerequisites ?? []) {
      const list = directDependents.get(prerequisite) ?? [];
      list.push(id);
      directDependents.set(prerequisite, list);
    }
    for (const prerequisite of closureOf(id)) {
      const list = transitiveDependents.get(prerequisite) ?? new Set();
      list.add(id);
      transitiveDependents.set(prerequisite, list);
    }
  }
  return { services, directDependents, transitiveDependents, prerequisiteClosure, order };
};

type Intent = "eager" | "lazy" | "stopped";

/** A launch's progress, named so a waiter's budget error can report where it's still blocked. */
type Stage = "preparing" | "launching";

/**
 * A service's point in its launch/stop cycle. `Running.ready` tracks the live health signal
 * separately from the phase itself: a readiness failure is not terminal, only a launch
 * failure or an exit is.
 */
type Phase = Data.TaggedEnum<{
  Stopped: {};
  Starting: { readonly generation: number; readonly stage: Stage };
  Running: { readonly generation: number; readonly ready: boolean };
  /** `crash` marks a generation whose runtime exited on its own: its cleanup ends in `Failed`. */
  Stopping: { readonly generation: number; readonly crash?: { readonly cause: unknown } };
  Failed: { readonly generation: number; readonly cause: unknown };
}>;
const Phase = Data.taggedEnum<Phase>();

interface BreakerState {
  readonly consecutiveFailures: number;
  readonly lastFailureAt: number | undefined;
  readonly openUntil: number | undefined;
  readonly lastCause: unknown;
}

const initialBreaker: BreakerState = {
  consecutiveFailures: 0,
  lastFailureAt: undefined,
  openUntil: undefined,
  lastCause: undefined,
};

interface Waiter {
  readonly id: number;
  /**
   * A traffic wait holds a lease and counts toward the cap; an explicit operation's wait only
   * observes readiness and fails with its prerequisite's outcome.
   */
  readonly kind: "traffic" | "explicit";
  /** False for an acquisition (such as the Functions inspector) that bypasses target readiness. */
  readonly requireReady: boolean;
}

/** Whether admission opens a work lease; an explicit operation's wait only observes readiness. */
const isLeaseWaiter = (waiter: Waiter): boolean => waiter.kind === "traffic";

export interface ServiceState {
  readonly intent: Intent;
  readonly phase: Phase;
  readonly leases: number;
  readonly idleEpoch: number;
  /** The epoch an outstanding idle timer was armed with, or undefined while none is armed. */
  readonly idleArmedEpoch: number | undefined;
  readonly breaker: BreakerState;
  readonly waiters: ReadonlyMap<number, Waiter>;
  /** Set by an explicit start or restart so the next launch attempt proceeds without demand. */
  readonly relaunchForced: boolean;
  /** Blocks every launch while a storage operation or destroy owns the stopped service. */
  readonly storageReserved: boolean;
  /**
   * A destroy waiting for the service to stop and any storage operation to release
   * (`requested`), or holding the storage reservation to remove its data (`reserved`).
   */
  readonly destroy: "requested" | "reserved" | undefined;
  /**
   * The current generation's last failed readiness check, cleared once it recovers or ends.
   * `reprobed` marks a failure that a re-check already confirmed, so the next one is spaced out.
   */
  readonly readinessFailure: { readonly cause: unknown; readonly reprobed: boolean } | undefined;
  /** Whether a `Reprobe` of the current generation is in flight; only one runs at a time. */
  readonly reprobing: boolean;
  /**
   * Set while `Stopping` when the last cleanup of that generation failed: its resources are still
   * held and no stop is in flight. A stop, restart, start or new waiter retries the cleanup.
   */
  readonly cleanupFailure: { readonly cause: unknown } | undefined;
  /** The newest restart candidate, consumed by the next `Launch` command. */
  readonly restartCandidate: unknown;
}

const initialService = (spec: ServiceSpec): ServiceState => ({
  intent: spec.activation,
  phase: Phase.Stopped(),
  leases: 0,
  idleEpoch: 0,
  idleArmedEpoch: undefined,
  breaker: initialBreaker,
  waiters: new Map(),
  relaunchForced: false,
  storageReserved: false,
  destroy: undefined,
  readinessFailure: undefined,
  reprobing: false,
  cleanupFailure: undefined,
  restartCandidate: undefined,
});

export interface LifecycleState {
  readonly graph: LifecycleGraph;
  readonly services: ReadonlyMap<string, ServiceState>;
  /**
   * The next generation to assign per service, kept outside `services` and never pruned: a
   * service removed and re-added by a `GraphUpdated` still can't reuse a generation number.
   */
  readonly generationCounters: ReadonlyMap<string, number>;
}

export const initialState = (graph: LifecycleGraph): LifecycleState => ({
  graph,
  services: new Map(
    [...graph.services.values()].map((spec): [string, ServiceState] => [
      spec.id,
      initialService(spec),
    ]),
  ),
  generationCounters: new Map([...graph.services.keys()].map((id) => [id, 1])),
});

export type LifecycleEvent = Data.TaggedEnum<{
  /** `requireReady: false` lets an acquisition (the Functions inspector) bypass target readiness. */
  ConnectionOpened: {
    readonly id: string;
    readonly waiterId: number;
    readonly requireReady: boolean;
  };
  ConnectionClosed: { readonly id: string };
  /** An explicit operation waiting for a session (or readiness) with no lease. */
  ReadinessAwaited: {
    readonly id: string;
    readonly waiterId: number;
    readonly requireReady: boolean;
  };
  /** A live session exists but hasn't passed its first health check; admits `requireReady: false`. */
  SessionAvailable: { readonly id: string; readonly generation: number };
  LaunchSucceeded: { readonly id: string; readonly generation: number };
  LaunchFailed: { readonly id: string; readonly generation: number; readonly cause: unknown };
  /**
   * A generation's runtime exited on its own and its cleanup has begun. Reported before the
   * cleanup runs, so nothing routes to the dead session while its resources are still held.
   */
  SessionLost: { readonly id: string; readonly generation: number; readonly cause: unknown };
  Exited: { readonly id: string; readonly generation: number; readonly requested: boolean };
  /**
   * A stop or a failed launch's cleanup of `generation` failed; its resources are still held.
   * `failure` carries the launch failure or crash that ended the generation, if one did, so it
   * still counts toward the breaker once.
   */
  StopFailed: {
    readonly id: string;
    readonly generation: number;
    readonly cause: unknown;
    readonly failure?: unknown;
  };
  IdleElapsed: { readonly id: string; readonly generation: number; readonly epoch: number };
  ReadinessLost: { readonly id: string; readonly generation: number; readonly cause: unknown };
  ReadinessRecovered: { readonly id: string; readonly generation: number };
  StageChanged: { readonly id: string; readonly generation: number; readonly stage: Stage };
  /** Fired by the runtime once a breaker's cooldown elapses; stale against the current breaker is a no-op. */
  CooldownElapsed: { readonly id: string; readonly openUntil: number };
  StartRequested: { readonly id: string };
  /** Arms a service for demand-driven launches without forcing one. */
  ArmRequested: { readonly id: string };
  StopRequested: { readonly id: string };
  /** `candidate`, when given, is the launch input the next launch uses in place of the saved one. */
  RestartRequested: { readonly id: string; readonly candidate?: unknown };
  StorageReserved: { readonly id: string };
  StorageReleased: { readonly id: string };
  /** Stops the service and reserves its storage for data removal once both are free. */
  DestroyRequested: { readonly id: string };
  /** A destroy gives up its request or reservation, whether or not it removed the data. */
  DestroyReleased: { readonly id: string };
  WaiterCancelled: { readonly id: string; readonly waiterId: number };
  /**
   * Atomically swaps the graph while preserving every continuing service's generation and epoch.
   * A service the update adds starts unarmed, so configuring a graph never launches anything.
   */
  GraphUpdated: { readonly graph: LifecycleGraph };
}>;
export const LifecycleEvent = Data.taggedEnum<LifecycleEvent>();

export type LifecycleCommand = Data.TaggedEnum<{
  /** `candidate` is the restart's launch input, or undefined when the saved one applies. */
  Launch: { readonly id: string; readonly generation: number; readonly candidate: unknown };
  Stop: { readonly id: string; readonly generation: number };
  ArmIdleTimer: {
    readonly id: string;
    readonly generation: number;
    readonly epoch: number;
    readonly delayMillis: number;
  };
  /** Schedules the `CooldownElapsed` event once the breaker's cooldown elapses. */
  ArmCooldownTimer: {
    readonly id: string;
    readonly openUntil: number;
    readonly delayMillis: number;
  };
  /** Re-runs a live session's failed readiness check, after `delayMillis`, because a waiter needs it. */
  Reprobe: { readonly id: string; readonly generation: number; readonly delayMillis: number };
  AdmitConnection: { readonly id: string; readonly waiterId: number };
  FailConnection: {
    readonly id: string;
    readonly waiterId: number;
    readonly message: string;
    readonly cause: unknown;
  };
  /** An explicit start, stop, restart, storage reservation or graph update the reducer refused. */
  RequestRejected: {
    readonly id: string;
    readonly operation: "start" | "stop" | "restart" | "storage" | "graph";
    readonly message: string;
  };
}>;
export const LifecycleCommand = Data.taggedEnum<LifecycleCommand>();

const generationOf = (phase: Phase): number | undefined =>
  Phase.$match(phase, {
    Stopped: () => undefined,
    Starting: (p) => p.generation,
    Running: (p) => p.generation,
    Stopping: (p) => p.generation,
    Failed: (p) => p.generation,
  });

const isUpOrWindingDown = (phase: Phase): boolean =>
  phase._tag === "Starting" || phase._tag === "Running" || phase._tag === "Stopping";

const isReady = (phase: Phase): boolean => phase._tag === "Running" && phase.ready;
const isSessionAvailable = (phase: Phase): boolean => phase._tag === "Running";

/**
 * An eager service's standing demand lapses once it fails, so a broken launch isn't retried in a
 * loop; traffic, a running dependent or an explicit start still relaunch it.
 */
const ownsDemand = (service: ServiceState): boolean =>
  (service.intent === "eager" && service.phase._tag !== "Failed") ||
  service.leases > 0 ||
  service.waiters.size > 0 ||
  service.relaunchForced;

/**
 * A dependent, anywhere in the transitive closure, that an explicit stop or restart of its
 * prerequisite would strand: one with live or retained demand, one still winding down, or one
 * merely wake-armed (lazy or eager, not explicitly stopped) and so able to need it again at any
 * moment. Internal idle sleep uses its own, narrower demand rule and is unaffected by this.
 */
const dependentIsActive = (service: ServiceState): boolean =>
  service.intent !== "stopped" || ownsDemand(service) || isUpOrWindingDown(service.phase);

/** A service active enough that a `GraphUpdated` removing or changing it would drop live or retained work. */
const isActiveForGraphUpdate = (service: ServiceState): boolean =>
  isUpOrWindingDown(service.phase) ||
  service.leases > 0 ||
  service.waiters.size > 0 ||
  service.storageReserved ||
  service.relaunchForced;

/** Whether two specs for the same id describe the same service, ignoring prerequisite order. */
const specsEqual = (a: ServiceSpec, b: ServiceSpec): boolean =>
  a.activation === b.activation &&
  a.idleMillis === b.idleMillis &&
  a.prerequisites.length === b.prerequisites.length &&
  a.prerequisites.every((prerequisite) => b.prerequisites.includes(prerequisite));

/**
 * A service has demand when it owns work itself (including an explicit start/restart that hasn't
 * launched yet), or a transitive dependent does, or a transitive dependent is admitted, starting
 * or running (held until its exit is confirmed). The dependent closure is checked directly (not
 * just the immediate one) so a wake deep in a fully stopped chain is visible to every prerequisite
 * in the same pass.
 */
const hasDemand = (state: LifecycleState, id: string): boolean => {
  const service = state.services.get(id);
  if (service === undefined) return false;
  if (ownsDemand(service)) return true;
  for (const dependent of state.graph.transitiveDependents.get(id) ?? []) {
    const dependentState = state.services.get(dependent);
    if (
      dependentState !== undefined &&
      (ownsDemand(dependentState) || isUpOrWindingDown(dependentState.phase))
    )
      return true;
  }
  return false;
};

/** Every prerequisite in the full transitive closure must itself be ready, not just direct ones. */
const prerequisitesSatisfied = (state: LifecycleState, id: string): boolean => {
  for (const prerequisite of state.graph.prerequisiteClosure.get(id) ?? []) {
    const prerequisiteState = state.services.get(prerequisite);
    if (prerequisiteState === undefined || !isReady(prerequisiteState.phase)) return false;
  }
  return true;
};

/** Effective readiness for admission: the target's own health and its prerequisite closure. */
const admissionReady = (state: LifecycleState, id: string): boolean => {
  const service = state.services.get(id);
  return service !== undefined && isReady(service.phase) && prerequisitesSatisfied(state, id);
};

/** A live session, bypassing the target's own health check, still behind its prerequisite closure. */
const sessionReady = (state: LifecycleState, id: string): boolean => {
  const service = state.services.get(id);
  return (
    service !== undefined && isSessionAvailable(service.phase) && prerequisitesSatisfied(state, id)
  );
};

/**
 * Whether the breaker is currently blocking admission. This is a plain flag, not a `now`
 * comparison: only the dedicated `CooldownElapsed` event clears it, so a stale or unrelated event
 * processed after the cooldown has elapsed on the wall clock can never itself reopen admission.
 */
const isBreakerOpen = (breaker: BreakerState): boolean => breaker.openUntil !== undefined;

/** Names what a pending waiter is still blocked on, for a budget-expiry error. */
export const blockingStage = (state: LifecycleState, id: string): string => {
  const service = state.services.get(id);
  if (service === undefined) return `${id} is unknown`;
  for (const prerequisite of state.graph.prerequisiteClosure.get(id) ?? []) {
    const prerequisiteState = state.services.get(prerequisite);
    if (prerequisiteState === undefined || !isReady(prerequisiteState.phase))
      return `prerequisite ${prerequisite}`;
  }
  if (service.phase._tag === "Starting") return `${id} to finish ${service.phase.stage}`;
  if (service.phase._tag !== "Running") return `${id} to start`;
  if (!service.phase.ready) return `${id} to become healthy`;
  return `${id}`;
};

const setService = (
  state: LifecycleState,
  id: string,
  update: (service: ServiceState) => ServiceState,
): LifecycleState => {
  const service = state.services.get(id);
  if (service === undefined) return state;
  return { ...state, services: new Map(state.services).set(id, update(service)) };
};

/** Fails every pending waiter of a service with one cause and clears its waiter queue. */
const failAllWaiters = (
  service: ServiceState,
  id: string,
  message: string,
  cause: unknown,
  commands: Array<LifecycleCommand>,
): ServiceState => {
  for (const waiter of service.waiters.values())
    commands.push(LifecycleCommand.FailConnection({ id, waiterId: waiter.id, message, cause }));
  return { ...service, waiters: new Map() };
};

/**
 * Fails every explicit operation's wait on a transitive dependent of a prerequisite that just
 * failed or lost readiness: such a wait has no budget, so it must end with the prerequisite's
 * outcome. Traffic waiters keep their demand and stay bounded by the orchestrator's budget.
 */
const failExplicitDependentWaiters = (
  state: LifecycleState,
  id: string,
  message: string,
  cause: unknown,
  commands: Array<LifecycleCommand>,
): LifecycleState => {
  let next = state;
  for (const dependent of state.graph.transitiveDependents.get(id) ?? []) {
    const service = next.services.get(dependent);
    if (service === undefined) continue;
    const explicit = [...service.waiters.values()].filter((waiter) => !isLeaseWaiter(waiter));
    if (explicit.length === 0) continue;
    const waiters = new Map(service.waiters);
    for (const waiter of explicit) {
      waiters.delete(waiter.id);
      commands.push(
        LifecycleCommand.FailConnection({ id: dependent, waiterId: waiter.id, message, cause }),
      );
    }
    next = setService(next, dependent, (s) => ({ ...s, waiters }));
  }
  return next;
};

/** Re-issues the stop of a generation whose last cleanup failed, if one is pending. */
const retryCleanup = (
  state: LifecycleState,
  id: string,
  commands: Array<LifecycleCommand>,
): LifecycleState => {
  const service = state.services.get(id);
  if (service?.phase._tag !== "Stopping" || service.cleanupFailure === undefined) return state;
  commands.push(LifecycleCommand.Stop({ id, generation: service.phase.generation }));
  return setService(state, id, (s) => ({ ...s, cleanupFailure: undefined }));
};

/**
 * Retries a failed cleanup that a newly queued waiter is blocked on, in its prerequisite closure
 * or the target itself. Only a new arrival retries, so a cleanup that keeps failing never loops.
 */
const retryBlockedCleanup = (
  state: LifecycleState,
  id: string,
  commands: Array<LifecycleCommand>,
): LifecycleState => {
  let next = state;
  for (const blocker of [...(state.graph.prerequisiteClosure.get(id) ?? []), id])
    next = retryCleanup(next, blocker, commands);
  return next;
};

/**
 * Whether a pending waiter needs this service ready: one of its own that requires readiness, or
 * any waiter of a transitive dependent, since admission requires the whole prerequisite closure.
 */
const blocksWaiters = (state: LifecycleState, id: string): boolean => {
  const service = state.services.get(id);
  if (service === undefined) return false;
  for (const waiter of service.waiters.values()) if (waiter.requireReady) return true;
  for (const dependent of state.graph.transitiveDependents.get(id) ?? [])
    if ((state.services.get(dependent)?.waiters.size ?? 0) > 0) return true;
  return false;
};

/** Queues or immediately resolves one traffic acquisition or explicit readiness wait. */
const openWaiter = (
  state: LifecycleState,
  id: string,
  waiterId: number,
  requireReady: boolean,
  traffic: boolean,
): readonly [LifecycleState, ReadonlyArray<LifecycleCommand>] => {
  const service = state.services.get(id);
  const spec = state.graph.services.get(id);
  if (service === undefined || spec === undefined) return [state, []];
  const fail = (message: string, cause: unknown) =>
    [state, [LifecycleCommand.FailConnection({ id, waiterId, message, cause })]] as const;
  if (service.intent === "stopped") return fail(`${id} is explicitly stopped`, undefined);
  const eligibleNow = requireReady ? admissionReady(state, id) : sessionReady(state, id);
  if (eligibleNow)
    return [
      traffic ? setService(state, id, (s) => ({ ...s, leases: s.leases + 1 })) : state,
      [LifecycleCommand.AdmitConnection({ id, waiterId })],
    ];
  if (isBreakerOpen(service.breaker))
    return fail(`${id} circuit breaker is open`, service.breaker.lastCause);
  // The cap bounds sockets held by traffic; explicit operations are few and already bounded.
  const trafficWaiters = [...service.waiters.values()].filter(isLeaseWaiter).length;
  if (traffic && trafficWaiters >= waiterCap) return fail(`${id} has too many waiters`, undefined);
  const commands: Array<LifecycleCommand> = [];
  const queued = setService(state, id, (s) => ({
    ...s,
    waiters: new Map(s.waiters).set(waiterId, {
      id: waiterId,
      kind: traffic ? "traffic" : "explicit",
      requireReady,
    }),
  }));
  return [retryBlockedCleanup(queued, id, commands), commands];
};

/** The transitive dependents currently active enough to block a stop or restart of a prerequisite. */
const activeDependents = (state: LifecycleState, id: string): ReadonlyArray<string> =>
  [...(state.graph.transitiveDependents.get(id) ?? [])].filter((dependentId) => {
    const dependentState = state.services.get(dependentId);
    return dependentState !== undefined && dependentIsActive(dependentState);
  });

/** Applies an explicit stop, or returns undefined after rejecting it for active dependents. */
const requestStop = (
  state: LifecycleState,
  id: string,
  commands: Array<LifecycleCommand>,
): LifecycleState | undefined => {
  const service = state.services.get(id);
  if (service === undefined) return undefined;
  // Checked independently of whether this service itself needs a `Stop` command: a `Failed`
  // target with an open breaker must still protect a dependent's retained demand.
  const blockers = activeDependents(state, id);
  if (blockers.length > 0) {
    commands.push(
      LifecycleCommand.RequestRejected({
        id,
        operation: "stop",
        message: `${id} has active dependents: ${blockers.join(", ")}`,
      }),
    );
    return undefined;
  }
  const winding = isUpOrWindingDown(service.phase) && service.phase._tag !== "Stopping";
  const failed = failAllWaiters(service, id, `${id} was explicitly stopped`, undefined, commands);
  const generation = generationOf(failed.phase);
  if (winding && generation !== undefined) commands.push(LifecycleCommand.Stop({ id, generation }));
  const phase =
    winding && generation !== undefined
      ? Phase.Stopping({ generation })
      : failed.phase._tag === "Failed"
        ? Phase.Stopped()
        : failed.phase;
  const stopped = setService(state, id, () => ({
    ...failed,
    intent: "stopped",
    relaunchForced: false,
    phase,
  }));
  return retryCleanup(stopped, id, commands);
};

/** Rejects an explicit start or restart of a service a destroy has claimed. */
const rejectWhileDestroying = (
  service: ServiceState,
  id: string,
  operation: "start" | "restart",
  commands: Array<LifecycleCommand>,
): boolean => {
  if (service.destroy === undefined) return false;
  commands.push(
    LifecycleCommand.RequestRejected({ id, operation, message: `${id} is being destroyed` }),
  );
  return true;
};

/** Re-arms every prerequisite an explicit start or restart depends on, clearing a stopped intent. */
const rearmPrerequisites = (state: LifecycleState, id: string): LifecycleState => {
  let next = state;
  for (const prerequisite of state.graph.prerequisiteClosure.get(id) ?? []) {
    const prerequisiteSpec = state.graph.services.get(prerequisite);
    if (prerequisiteSpec === undefined) continue;
    next = setService(next, prerequisite, (s) =>
      s.intent === "stopped" ? { ...s, intent: prerequisiteSpec.activation } : s,
    );
  }
  return next;
};

/** Counts one generation's launch failure or crash, opening the breaker at the threshold. */
const countFailure = (
  service: ServiceState,
  id: string,
  cause: unknown,
  now: number,
  commands: Array<LifecycleCommand>,
): BreakerState => {
  const { lastFailureAt } = service.breaker;
  const consecutiveFailures =
    lastFailureAt !== undefined && now - lastFailureAt > breakerWindowMillis
      ? 1
      : service.breaker.consecutiveFailures + 1;
  if (consecutiveFailures < breakerThreshold)
    return { consecutiveFailures, lastFailureAt: now, openUntil: undefined, lastCause: cause };
  const openUntil = now + breakerCooldownMillis;
  commands.push(
    LifecycleCommand.ArmCooldownTimer({ id, openUntil, delayMillis: breakerCooldownMillis }),
  );
  return { consecutiveFailures, lastFailureAt: now, openUntil, lastCause: cause };
};

const recordFailure = (
  state: LifecycleState,
  id: string,
  generation: number,
  cause: unknown,
  now: number,
  commands: Array<LifecycleCommand>,
): LifecycleState =>
  setService(
    failExplicitDependentWaiters(state, id, `prerequisite ${id} failed`, cause, commands),
    id,
    (service) => {
      const failed = failAllWaiters(service, id, `${id} failed`, cause, commands);
      return {
        ...failed,
        phase: Phase.Failed({ generation, cause }),
        breaker: countFailure(service, id, cause, now, commands),
        idleArmedEpoch: undefined,
        relaunchForced: false,
        readinessFailure: undefined,
        reprobing: false,
      };
    },
  );

const applyEvent = (
  state: LifecycleState,
  event: LifecycleEvent,
  now: number,
): readonly [LifecycleState, ReadonlyArray<LifecycleCommand>] => {
  const commands: Array<LifecycleCommand> = [];

  switch (event._tag) {
    case "ConnectionOpened":
      return openWaiter(state, event.id, event.waiterId, event.requireReady, true);
    case "ReadinessAwaited":
      return openWaiter(state, event.id, event.waiterId, event.requireReady, false);
    case "ConnectionClosed": {
      return [
        setService(state, event.id, (s) => ({ ...s, leases: Math.max(0, s.leases - 1) })),
        commands,
      ];
    }
    case "SessionAvailable": {
      const { id, generation } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Starting" ||
        service.phase.generation !== generation
      )
        break;
      return [
        setService(state, id, (s) => ({
          ...s,
          phase: Phase.Running({ generation, ready: false }),
          readinessFailure: undefined,
          reprobing: false,
        })),
        commands,
      ];
    }
    case "LaunchSucceeded": {
      const { id, generation } = event;
      const service = state.services.get(id);
      if (service === undefined || generationOf(service.phase) !== generation) break;
      // Accepted either straight from `Starting` or after a `SessionAvailable` left it unready.
      const fromStarting = service.phase._tag === "Starting";
      const fromUnreadySession = service.phase._tag === "Running" && !service.phase.ready;
      if (!fromStarting && !fromUnreadySession) break;
      return [
        setService(state, id, (s) => ({
          ...s,
          phase: Phase.Running({ generation, ready: true }),
          readinessFailure: undefined,
          reprobing: false,
        })),
        commands,
      ];
    }
    case "LaunchFailed": {
      const { id, generation, cause } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Starting" ||
        service.phase.generation !== generation
      )
        break;
      return [recordFailure(state, id, generation, cause, now, commands), commands];
    }
    case "SessionLost": {
      const { id, generation, cause } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        (service.phase._tag !== "Starting" && service.phase._tag !== "Running") ||
        service.phase.generation !== generation
      )
        break;
      // The crash counts and fails its waiters now; the generation then winds down like a stop.
      const failed = recordFailure(state, id, generation, cause, now, commands);
      return [
        setService(failed, id, (s) => ({
          ...s,
          phase: Phase.Stopping({ generation, crash: { cause } }),
        })),
        commands,
      ];
    }
    case "Exited": {
      const { id, generation, requested } = event;
      const service = state.services.get(id);
      if (service === undefined || generationOf(service.phase) !== generation) break;
      if (service.phase._tag === "Stopping" || requested) {
        // An explicit stop that arrived during a crash's cleanup wins: it ends `Stopped`.
        const crash =
          service.phase._tag === "Stopping" && service.intent !== "stopped"
            ? service.phase.crash
            : undefined;
        return [
          setService(state, id, (s) => ({
            ...s,
            phase:
              crash === undefined
                ? Phase.Stopped()
                : Phase.Failed({ generation, cause: crash.cause }),
            idleArmedEpoch: undefined,
            readinessFailure: undefined,
            reprobing: false,
            cleanupFailure: undefined,
          })),
          commands,
        ];
      }
      break;
    }
    case "StopFailed": {
      const { id, generation, cause, failure } = event;
      const service = state.services.get(id);
      if (service === undefined || generationOf(service.phase) !== generation) break;
      // Nothing may launch or reserve storage while resources are held, and waiters can't be
      // served by a generation that is going away, so they get the cleanup failure now.
      const message = `${id} cleanup failed`;
      const dependentsFailed = failExplicitDependentWaiters(
        state,
        id,
        `prerequisite ${message}`,
        cause,
        commands,
      );
      return [
        setService(dependentsFailed, id, (s) => ({
          ...failAllWaiters(s, id, message, cause, commands),
          phase: Phase.Stopping({ generation }),
          breaker:
            failure === undefined ||
            service.phase._tag === "Stopping" ||
            service.phase._tag === "Failed"
              ? s.breaker
              : countFailure(s, id, failure, now, commands),
          idleArmedEpoch: undefined,
          relaunchForced: false,
          readinessFailure: undefined,
          reprobing: false,
          cleanupFailure: { cause },
        })),
        commands,
      ];
    }
    case "IdleElapsed": {
      const { id, generation, epoch } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Running" ||
        service.phase.generation !== generation ||
        service.idleArmedEpoch !== epoch ||
        hasDemand(state, id)
      )
        break;
      commands.push(LifecycleCommand.Stop({ id, generation }));
      return [
        setService(state, id, (s) => ({
          ...s,
          phase: Phase.Stopping({ generation }),
          idleArmedEpoch: undefined,
        })),
        commands,
      ];
    }
    case "ReadinessLost": {
      const { id, generation, cause } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Running" ||
        service.phase.generation !== generation
      )
        break;
      // Not terminal: the live session is kept, and the next waiter that needs it triggers a
      // `Reprobe`. Waiters already awaiting this readiness get the check's failure.
      const message = `${id} is not ready`;
      const dependentsFailed = failExplicitDependentWaiters(
        state,
        id,
        `prerequisite ${message}`,
        cause,
        commands,
      );
      return [
        setService(dependentsFailed, id, (s) => {
          const waiters = new Map(s.waiters);
          for (const waiter of s.waiters.values()) {
            if (!waiter.requireReady) continue;
            waiters.delete(waiter.id);
            commands.push(
              LifecycleCommand.FailConnection({ id, waiterId: waiter.id, message, cause }),
            );
          }
          return {
            ...s,
            phase: Phase.Running({ generation, ready: false }),
            waiters,
            readinessFailure: { cause, reprobed: s.reprobing },
            reprobing: false,
          };
        }),
        commands,
      ];
    }
    case "ReadinessRecovered": {
      const { id, generation } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Running" ||
        service.phase.generation !== generation
      )
        break;
      return [
        setService(state, id, (s) => ({
          ...s,
          phase: Phase.Running({ generation, ready: true }),
          readinessFailure: undefined,
          reprobing: false,
        })),
        commands,
      ];
    }
    case "StageChanged": {
      const { id, generation, stage } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Starting" ||
        service.phase.generation !== generation
      )
        break;
      return [
        setService(state, id, (s) => ({ ...s, phase: Phase.Starting({ generation, stage }) })),
        commands,
      ];
    }
    case "CooldownElapsed": {
      const { id, openUntil } = event;
      const service = state.services.get(id);
      if (service === undefined || service.breaker.openUntil !== openUntil) break;
      return [
        setService(state, id, (s) => ({ ...s, breaker: { ...s.breaker, openUntil: undefined } })),
        commands,
      ];
    }
    case "StartRequested": {
      const { id } = event;
      const service = state.services.get(id);
      const spec = state.graph.services.get(id);
      if (service === undefined || spec === undefined) break;
      if (rejectWhileDestroying(service, id, "start", commands)) break;
      // A service already `Running` has nothing left to force, and forcing it here would wrongly
      // survive into a later, unrelated idle cycle. One already `Stopping` is different: that
      // generation's end is imminent and this request's demand must carry through to the next one
      // (its own exit confirmation is the only thing that will ever consume this flag).
      const forced =
        service.phase._tag === "Stopped" ||
        service.phase._tag === "Failed" ||
        service.phase._tag === "Stopping";
      const updated = setService(state, id, (s) => ({
        ...s,
        intent: spec.activation,
        breaker: initialBreaker,
        relaunchForced: s.relaunchForced || forced,
      }));
      return [rearmPrerequisites(retryCleanup(updated, id, commands), id), commands];
    }
    case "ArmRequested": {
      const { id } = event;
      const spec = state.graph.services.get(id);
      const service = state.services.get(id);
      if (spec === undefined || service === undefined || service.destroy !== undefined) break;
      return [
        setService(state, id, (s) => ({ ...s, intent: spec.activation, breaker: initialBreaker })),
        commands,
      ];
    }
    case "StopRequested": {
      const stopped = requestStop(state, event.id, commands);
      return [stopped ?? state, commands];
    }
    case "DestroyRequested": {
      const stopped = requestStop(state, event.id, commands);
      if (stopped === undefined) break;
      return [
        setService(stopped, event.id, (s) => ({ ...s, destroy: s.destroy ?? "requested" })),
        commands,
      ];
    }
    case "DestroyReleased": {
      return [
        setService(state, event.id, (s) =>
          s.destroy === undefined
            ? s
            : {
                ...s,
                destroy: undefined,
                storageReserved: s.destroy === "reserved" ? false : s.storageReserved,
              },
        ),
        commands,
      ];
    }
    case "RestartRequested": {
      const { id } = event;
      const service = state.services.get(id);
      const spec = state.graph.services.get(id);
      if (service === undefined || spec === undefined) break;
      if (rejectWhileDestroying(service, id, "restart", commands)) break;
      const blockers = activeDependents(state, id);
      if (blockers.length > 0) {
        commands.push(
          LifecycleCommand.RequestRejected({
            id,
            operation: "restart",
            message: `${id} has active dependents: ${blockers.join(", ")}`,
          }),
        );
        break;
      }
      const winding = isUpOrWindingDown(service.phase) && service.phase._tag !== "Stopping";
      const generation = generationOf(service.phase);
      if (winding && generation !== undefined)
        commands.push(LifecycleCommand.Stop({ id, generation }));
      const updated = setService(state, id, (s) => ({
        ...s,
        intent: spec.activation,
        breaker: initialBreaker,
        relaunchForced: true,
        restartCandidate: event.candidate === undefined ? s.restartCandidate : event.candidate,
        phase: winding && generation !== undefined ? Phase.Stopping({ generation }) : s.phase,
      }));
      return [rearmPrerequisites(retryCleanup(updated, id, commands), id), commands];
    }
    case "StorageReserved": {
      const { id } = event;
      const service = state.services.get(id);
      if (service === undefined) break;
      if (service.destroy !== undefined) {
        commands.push(
          LifecycleCommand.RequestRejected({
            id,
            operation: "storage",
            message: `${id} is being destroyed`,
          }),
        );
        break;
      }
      if (
        service.phase._tag !== "Stopped" ||
        service.intent !== "stopped" ||
        service.storageReserved
      ) {
        commands.push(
          LifecycleCommand.RequestRejected({
            id,
            operation: "storage",
            message: `${id} must be stopped with wake disabled before modifying data`,
          }),
        );
        break;
      }
      return [setService(state, id, (s) => ({ ...s, storageReserved: true })), commands];
    }
    case "StorageReleased": {
      // Destroy's own reservation ends only with `DestroyReleased`.
      return [
        setService(state, event.id, (s) =>
          s.destroy === "reserved" ? s : { ...s, storageReserved: false },
        ),
        commands,
      ];
    }
    case "WaiterCancelled": {
      const { id, waiterId } = event;
      return [
        setService(state, id, (s) => {
          if (!s.waiters.has(waiterId)) return s;
          const waiters = new Map(s.waiters);
          waiters.delete(waiterId);
          return { ...s, waiters };
        }),
        commands,
      ];
    }
    case "GraphUpdated": {
      const { graph } = event;
      const removedIds = [...state.graph.services.keys()].filter((id) => !graph.services.has(id));
      const changedIds = [...state.graph.services.keys()].filter((id) => {
        const previousSpec = state.graph.services.get(id);
        const nextSpec = graph.services.get(id);
        return (
          previousSpec !== undefined &&
          nextSpec !== undefined &&
          !specsEqual(previousSpec, nextSpec)
        );
      });
      // A destroy holding its reservation owns the service, so its removal can't be blocked.
      const destroyed = (id: string) => state.services.get(id)?.destroy === "reserved";
      const blockedIds = [...removedIds.filter((id) => !destroyed(id)), ...changedIds].filter(
        (id) => {
          const service = state.services.get(id);
          return service !== undefined && isActiveForGraphUpdate(service);
        },
      );
      if (blockedIds.length > 0) {
        for (const id of blockedIds)
          commands.push(
            LifecycleCommand.RequestRejected({
              id,
              operation: "graph",
              message: `${id} is active and can't be removed or changed by a graph update`,
            }),
          );
        break;
      }
      const services = new Map<string, ServiceState>();
      const generationCounters = new Map(state.generationCounters);
      for (const spec of graph.services.values()) {
        const existing = state.services.get(spec.id);
        services.set(spec.id, existing ?? { ...initialService(spec), intent: "stopped" });
        if (!generationCounters.has(spec.id)) generationCounters.set(spec.id, 1);
      }
      return [{ graph, services, generationCounters }, commands];
    }
  }

  return [state, commands];
};

/**
 * Cascades launches, idle arming and waiter resolution across the graph after one event. A
 * single topological pass suffices: a launch started here only reaches `Running` on a later
 * event, so a dependent several hops away naturally waits for its own future turn. Every
 * condition here is a function of state alone, so replaying this pass for a stale or unrelated
 * event can never surface a new launch or admission on its own; only the dedicated time-driven
 * events (`CooldownElapsed`, `IdleElapsed`) do that.
 */
const settle = (
  state: LifecycleState,
  commands: ReadonlyArray<LifecycleCommand>,
): readonly [LifecycleState, ReadonlyArray<LifecycleCommand>] => {
  let next = state;
  const emitted: Array<LifecycleCommand> = [...commands];

  // A pending destroy takes the storage reservation as soon as the service is stopped and free.
  for (const [id, service] of next.services)
    if (
      service.destroy === "requested" &&
      service.phase._tag === "Stopped" &&
      !service.storageReserved
    )
      next = setService(next, id, (s) => ({ ...s, destroy: "reserved", storageReserved: true }));

  for (const id of next.graph.order) {
    const spec = next.graph.services.get(id);
    const service = next.services.get(id);
    if (spec === undefined || service === undefined) continue;

    if (service.phase._tag === "Stopped" || service.phase._tag === "Failed") {
      if (service.intent === "stopped") continue;
      if (service.storageReserved) continue;
      if (isBreakerOpen(service.breaker)) continue;
      if (!prerequisitesSatisfied(next, id)) continue;
      if (!hasDemand(next, id) && !service.relaunchForced) continue;
      const generation = next.generationCounters.get(id) ?? 1;
      emitted.push(
        LifecycleCommand.Launch({ id, generation, candidate: service.restartCandidate }),
      );
      next = {
        ...setService(next, id, (s) => ({
          ...s,
          phase: Phase.Starting({ generation, stage: "preparing" }),
          relaunchForced: false,
          restartCandidate: undefined,
          readinessFailure: undefined,
          reprobing: false,
        })),
        generationCounters: new Map(next.generationCounters).set(id, generation + 1),
      };
      continue;
    }

    if (service.phase._tag === "Running") {
      const generation = service.phase.generation;
      // A blocking unhealthy session is re-checked until it recovers, its generation ends or no
      // waiter needs it; their budgets bound how long that lasts.
      if (
        !service.phase.ready &&
        service.readinessFailure !== undefined &&
        !service.reprobing &&
        blocksWaiters(next, id)
      ) {
        emitted.push(
          LifecycleCommand.Reprobe({
            id,
            generation,
            delayMillis: service.readinessFailure.reprobed ? reprobeSpacingMillis : 0,
          }),
        );
        next = setService(next, id, (s) => ({ ...s, reprobing: true }));
      }
      if (prerequisitesSatisfied(next, id) && service.waiters.size > 0) {
        const ready = service.phase.ready;
        const admitted: Array<number> = [];
        for (const waiter of service.waiters.values())
          if (!waiter.requireReady || ready) admitted.push(waiter.id);
        if (admitted.length > 0) {
          const leased = admitted.filter((waiterId) => {
            const waiter = service.waiters.get(waiterId);
            return waiter !== undefined && isLeaseWaiter(waiter);
          }).length;
          for (const waiterId of admitted)
            emitted.push(LifecycleCommand.AdmitConnection({ id, waiterId }));
          next = setService(next, id, (s) => {
            const waiters = new Map(s.waiters);
            for (const waiterId of admitted) waiters.delete(waiterId);
            return { ...s, leases: s.leases + leased, waiters };
          });
        }
      }
      const settled = next.services.get(id);
      if (settled === undefined) continue;
      const idles =
        settled.intent === "lazy" &&
        spec.idleMillis !== undefined &&
        settled.phase._tag === "Running";
      if (idles && settled.phase._tag === "Running") {
        const demand = hasDemand(next, id);
        if (demand && settled.idleArmedEpoch !== undefined) {
          // Demand returning invalidates any outstanding timer regardless of readiness: an idle
          // arm/clear decision must never be stranded by a readiness loss that follows it, or the
          // service could never become idle-eligible again once readiness recovers.
          next = setService(next, id, (s) => ({ ...s, idleArmedEpoch: undefined }));
        } else if (!demand && settled.phase.ready && settled.idleArmedEpoch === undefined) {
          const epoch = settled.idleEpoch + 1;
          emitted.push(
            LifecycleCommand.ArmIdleTimer({
              id,
              generation,
              epoch,
              delayMillis: spec.idleMillis ?? 0,
            }),
          );
          next = setService(next, id, (s) => ({ ...s, idleEpoch: epoch, idleArmedEpoch: epoch }));
        }
      }
    }
  }

  return [next, emitted];
};

/** The one pure `(state, event, now) -> (state, commands)` step for an owner's whole graph. */
export const reduce = (
  state: LifecycleState,
  event: LifecycleEvent,
  now: number,
): readonly [LifecycleState, ReadonlyArray<LifecycleCommand>] => {
  const [applied, directCommands] = applyEvent(state, event, now);
  return settle(applied, directCommands);
};

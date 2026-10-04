import { Data } from "effect";

/** Default per-waiter wake budget; a service's spec may override it for known-slow launches. */
const defaultWaiterBudgetMillis = 120_000;
const waiterCap = 256;
const breakerThreshold = 3;
const breakerBaseCooldownMillis = 30_000;
const breakerMaxCooldownMillis = 300_000;
const breakerStabilityMillis = 30_000;

/** One member of the owner's composition graph, as the reducer needs to see it. */
export interface ServiceSpec {
  readonly id: string;
  readonly activation: "eager" | "lazy";
  readonly prerequisites: ReadonlyArray<string>;
  /** Undefined means the service never sleeps on idle. */
  readonly idleMillis?: number;
  readonly waiterBudgetMillis?: number;
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
type Stage = "preparing" | "artifacts" | "launching";

/**
 * A service's point in its launch/stop cycle. `Running.ready` tracks the live health signal
 * separately from the phase itself: a readiness failure is not terminal, only a launch
 * failure or an exit is.
 */
type Phase = Data.TaggedEnum<{
  Stopped: {};
  Starting: { readonly generation: number; readonly stage: Stage };
  Running: { readonly generation: number; readonly ready: boolean };
  Stopping: { readonly generation: number };
  Failed: { readonly generation: number; readonly cause: unknown };
}>;
const Phase = Data.taggedEnum<Phase>();

interface BreakerState {
  readonly consecutiveFailures: number;
  readonly openUntil: number | undefined;
  /** The cooldown this breaker will use next time it opens; doubles on each repeat open. */
  readonly cooldownMillis: number;
  readonly lastCause: unknown;
  /** The generation and timestamp its stability reset is counting from; cleared by a readiness loss or an exit. */
  readonly stableGeneration: number | undefined;
  readonly stableSince: number | undefined;
}

const initialBreaker: BreakerState = {
  consecutiveFailures: 0,
  openUntil: undefined,
  cooldownMillis: breakerBaseCooldownMillis,
  lastCause: undefined,
  stableGeneration: undefined,
  stableSince: undefined,
};

interface Waiter {
  readonly id: number;
  readonly deadline: number;
  /** False for an acquisition (such as the Functions inspector) that bypasses target readiness. */
  readonly requireReady: boolean;
}

export interface ServiceState {
  readonly intent: Intent;
  readonly phase: Phase;
  readonly leases: number;
  readonly lastActivity: number;
  readonly idleEpoch: number;
  /** The epoch an outstanding idle timer was armed with, or undefined while none is armed. */
  readonly idleArmedEpoch: number | undefined;
  readonly breaker: BreakerState;
  readonly waiters: ReadonlyMap<number, Waiter>;
  /** Set by an explicit start or restart so the next launch attempt proceeds without demand. */
  readonly relaunchForced: boolean;
  /** Blocks every launch while a storage operation owns the stopped service. */
  readonly storageReserved: boolean;
}

const initialService = (spec: ServiceSpec, now: number): ServiceState => ({
  intent: spec.activation,
  phase: Phase.Stopped(),
  leases: 0,
  lastActivity: now,
  idleEpoch: 0,
  idleArmedEpoch: undefined,
  breaker: initialBreaker,
  waiters: new Map(),
  relaunchForced: false,
  storageReserved: false,
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

export const initialState = (graph: LifecycleGraph, now: number): LifecycleState => ({
  graph,
  services: new Map(
    [...graph.services.values()].map((spec): [string, ServiceState] => [
      spec.id,
      initialService(spec, now),
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
  /** A live session exists but hasn't passed its first health check; admits `requireReady: false`. */
  SessionAvailable: { readonly id: string; readonly generation: number };
  LaunchSucceeded: { readonly id: string; readonly generation: number };
  LaunchFailed: { readonly id: string; readonly generation: number; readonly cause: unknown };
  Exited: {
    readonly id: string;
    readonly generation: number;
    readonly cause: unknown;
    readonly requested: boolean;
  };
  IdleElapsed: { readonly id: string; readonly generation: number; readonly epoch: number };
  ReadinessLost: { readonly id: string; readonly generation: number; readonly cause: unknown };
  ReadinessRecovered: { readonly id: string; readonly generation: number };
  StageChanged: { readonly id: string; readonly generation: number; readonly stage: Stage };
  /** Fired by the runtime once a breaker's cooldown elapses; stale against the current breaker is a no-op. */
  CooldownElapsed: { readonly id: string; readonly openUntil: number };
  StartRequested: { readonly id: string };
  StopRequested: { readonly id: string };
  RestartRequested: { readonly id: string };
  StorageReserved: { readonly id: string };
  StorageReleased: { readonly id: string };
  WaiterExpired: { readonly id: string; readonly waiterId: number };
  WaiterCancelled: { readonly id: string; readonly waiterId: number };
  /** Atomically swaps the graph while preserving every continuing service's generation and epoch. */
  GraphUpdated: { readonly graph: LifecycleGraph };
}>;
export const LifecycleEvent = Data.taggedEnum<LifecycleEvent>();

export type LifecycleCommand = Data.TaggedEnum<{
  Launch: { readonly id: string; readonly generation: number };
  Stop: { readonly id: string; readonly generation: number };
  ArmIdleTimer: {
    readonly id: string;
    readonly generation: number;
    readonly epoch: number;
    readonly delayMillis: number;
  };
  ArmWaiterTimeout: { readonly id: string; readonly waiterId: number; readonly deadline: number };
  /** Schedules the `CooldownElapsed` event once the breaker's cooldown elapses. */
  ArmCooldownTimer: {
    readonly id: string;
    readonly openUntil: number;
    readonly delayMillis: number;
  };
  /** Re-run the live session's readiness probe after it lost readiness without exiting. */
  Reprobe: { readonly id: string; readonly generation: number };
  AdmitConnection: { readonly id: string; readonly waiterId: number };
  FailConnection: {
    readonly id: string;
    readonly waiterId: number;
    readonly message: string;
    readonly cause: unknown;
  };
  /** An explicit stop, restart, storage reservation or graph update the reducer refused to admit. */
  RequestRejected: {
    readonly id: string;
    readonly operation: "stop" | "restart" | "storage" | "graph";
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

const ownsDemand = (service: ServiceState): boolean =>
  service.intent === "eager" ||
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
  a.waiterBudgetMillis === b.waiterBudgetMillis &&
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

const isStabilized = (breaker: BreakerState, phase: Phase, now: number): boolean =>
  breaker.stableGeneration !== undefined &&
  breaker.stableGeneration === generationOf(phase) &&
  breaker.stableSince !== undefined &&
  now - breaker.stableSince >= breakerStabilityMillis;

/** Bakes in a stability reset that has already been earned before its evidence is discarded. */
const materializeStability = (breaker: BreakerState, phase: Phase, now: number): BreakerState =>
  isStabilized(breaker, phase, now)
    ? {
        ...breaker,
        consecutiveFailures: 0,
        cooldownMillis: breakerBaseCooldownMillis,
        stableGeneration: undefined,
        stableSince: undefined,
      }
    : breaker;

/**
 * Whether the breaker is currently blocking admission. This is a plain flag, not a `now`
 * comparison: only the dedicated `CooldownElapsed` event clears it, so a stale or unrelated event
 * processed after the cooldown has elapsed on the wall clock can never itself reopen admission.
 */
const isBreakerOpen = (breaker: BreakerState): boolean => breaker.openUntil !== undefined;

/** Names what a pending waiter is still blocked on, for a budget-expiry error. */
const blockingStage = (state: LifecycleState, id: string): string => {
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

/** The transitive dependents currently active enough to block a stop or restart of a prerequisite. */
const activeDependents = (state: LifecycleState, id: string): ReadonlyArray<string> =>
  [...(state.graph.transitiveDependents.get(id) ?? [])].filter((dependentId) => {
    const dependentState = state.services.get(dependentId);
    return dependentState !== undefined && dependentIsActive(dependentState);
  });

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

/** Shared breaker/phase bookkeeping for a launch failure or an unrequested exit. */
const recordFailure = (
  state: LifecycleState,
  id: string,
  generation: number,
  cause: unknown,
  now: number,
  commands: Array<LifecycleCommand>,
): LifecycleState =>
  setService(state, id, (service) => {
    const materialized = materializeStability(service.breaker, service.phase, now);
    const consecutiveFailures = materialized.consecutiveFailures + 1;
    const opens = consecutiveFailures >= breakerThreshold;
    let breaker: BreakerState;
    if (opens) {
      const openUntil = now + materialized.cooldownMillis;
      commands.push(
        LifecycleCommand.ArmCooldownTimer({
          id,
          openUntil,
          delayMillis: materialized.cooldownMillis,
        }),
      );
      breaker = {
        consecutiveFailures,
        openUntil,
        cooldownMillis: Math.min(breakerMaxCooldownMillis, materialized.cooldownMillis * 2),
        lastCause: cause,
        stableGeneration: undefined,
        stableSince: undefined,
      };
    } else {
      breaker = {
        consecutiveFailures,
        openUntil: undefined,
        cooldownMillis: materialized.cooldownMillis,
        lastCause: cause,
        stableGeneration: undefined,
        stableSince: undefined,
      };
    }
    const failed = failAllWaiters(service, id, `${id} failed`, cause, commands);
    return {
      ...failed,
      phase: Phase.Failed({ generation, cause }),
      breaker,
      idleArmedEpoch: undefined,
      relaunchForced: false,
    };
  });

const applyEvent = (
  state: LifecycleState,
  event: LifecycleEvent,
  now: number,
): readonly [LifecycleState, ReadonlyArray<LifecycleCommand>] => {
  const commands: Array<LifecycleCommand> = [];

  switch (event._tag) {
    case "ConnectionOpened": {
      const { id, waiterId, requireReady } = event;
      const service = state.services.get(id);
      const spec = state.graph.services.get(id);
      if (service === undefined || spec === undefined) break;
      if (service.intent === "stopped") {
        commands.push(
          LifecycleCommand.FailConnection({
            id,
            waiterId,
            message: `${id} is explicitly stopped`,
            cause: undefined,
          }),
        );
        break;
      }
      const eligibleNow = requireReady ? admissionReady(state, id) : sessionReady(state, id);
      if (eligibleNow) {
        return [
          setService(state, id, (s) => ({ ...s, leases: s.leases + 1, lastActivity: now })),
          [LifecycleCommand.AdmitConnection({ id, waiterId })],
        ];
      }
      if (isBreakerOpen(service.breaker)) {
        commands.push(
          LifecycleCommand.FailConnection({
            id,
            waiterId,
            message: `${id} circuit breaker is open`,
            cause: service.breaker.lastCause,
          }),
        );
        break;
      }
      if (service.waiters.size >= waiterCap) {
        commands.push(
          LifecycleCommand.FailConnection({
            id,
            waiterId,
            message: `${id} has too many waiters`,
            cause: undefined,
          }),
        );
        break;
      }
      const deadline = now + (spec.waiterBudgetMillis ?? defaultWaiterBudgetMillis);
      commands.push(LifecycleCommand.ArmWaiterTimeout({ id, waiterId, deadline }));
      return [
        setService(state, id, (s) => ({
          ...s,
          lastActivity: now,
          waiters: new Map(s.waiters).set(waiterId, { id: waiterId, deadline, requireReady }),
        })),
        commands,
      ];
    }
    case "ConnectionClosed": {
      return [
        setService(state, event.id, (s) => ({
          ...s,
          leases: Math.max(0, s.leases - 1),
          lastActivity: now,
        })),
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
          breaker: { ...s.breaker, stableGeneration: generation, stableSince: now },
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
    case "Exited": {
      const { id, generation, cause, requested } = event;
      const service = state.services.get(id);
      if (service === undefined || generationOf(service.phase) !== generation) break;
      if (service.phase._tag === "Stopping" || requested) {
        return [
          setService(state, id, (s) => ({
            ...s,
            phase: Phase.Stopped(),
            idleArmedEpoch: undefined,
          })),
          commands,
        ];
      }
      if (service.phase._tag === "Running" || service.phase._tag === "Starting")
        return [recordFailure(state, id, generation, cause, now, commands), commands];
      break;
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
          // Bake in any 30s stability the just-ending generation already earned, since the next
          // failure to check it will compare against a different, unrelated generation.
          breaker: materializeStability(s.breaker, s.phase, now),
        })),
        commands,
      ];
    }
    case "ReadinessLost": {
      const { id, generation } = event;
      const service = state.services.get(id);
      if (
        service === undefined ||
        service.phase._tag !== "Running" ||
        service.phase.generation !== generation
      )
        break;
      commands.push(LifecycleCommand.Reprobe({ id, generation }));
      return [
        setService(state, id, (s) => ({
          ...s,
          phase: Phase.Running({ generation, ready: false }),
          breaker: {
            ...materializeStability(s.breaker, s.phase, now),
            stableGeneration: undefined,
            stableSince: undefined,
          },
        })),
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
          breaker: { ...s.breaker, stableGeneration: generation, stableSince: now },
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
      return [rearmPrerequisites(updated, id), commands];
    }
    case "StopRequested": {
      const { id } = event;
      const service = state.services.get(id);
      if (service === undefined) break;
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
        break;
      }
      const winding = isUpOrWindingDown(service.phase) && service.phase._tag !== "Stopping";
      const failed = failAllWaiters(
        service,
        id,
        `${id} was explicitly stopped`,
        undefined,
        commands,
      );
      const generation = generationOf(failed.phase);
      if (winding && generation !== undefined)
        commands.push(LifecycleCommand.Stop({ id, generation }));
      const phase =
        winding && generation !== undefined
          ? Phase.Stopping({ generation })
          : failed.phase._tag === "Failed"
            ? Phase.Stopped()
            : failed.phase;
      return [
        setService(state, id, () => ({
          ...failed,
          intent: "stopped",
          relaunchForced: false,
          phase,
        })),
        commands,
      ];
    }
    case "RestartRequested": {
      const { id } = event;
      const service = state.services.get(id);
      const spec = state.graph.services.get(id);
      if (service === undefined || spec === undefined) break;
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
        phase: winding && generation !== undefined ? Phase.Stopping({ generation }) : s.phase,
      }));
      return [rearmPrerequisites(updated, id), commands];
    }
    case "StorageReserved": {
      const { id } = event;
      const service = state.services.get(id);
      if (service === undefined) break;
      if (
        service.phase._tag !== "Stopped" ||
        service.intent !== "stopped" ||
        service.storageReserved
      ) {
        commands.push(
          LifecycleCommand.RequestRejected({
            id,
            operation: "storage",
            message: `${id} must be stopped before a storage operation`,
          }),
        );
        break;
      }
      return [setService(state, id, (s) => ({ ...s, storageReserved: true })), commands];
    }
    case "StorageReleased": {
      return [setService(state, event.id, (s) => ({ ...s, storageReserved: false })), commands];
    }
    case "WaiterExpired": {
      const { id, waiterId } = event;
      const service = state.services.get(id);
      const waiter = service?.waiters.get(waiterId);
      if (service === undefined || waiter === undefined) break;
      commands.push(
        LifecycleCommand.FailConnection({
          id,
          waiterId,
          message: `${id} wake budget exceeded while waiting for ${blockingStage(state, id)}`,
          cause: undefined,
        }),
      );
      return [
        setService(state, id, (s) => {
          const waiters = new Map(s.waiters);
          waiters.delete(waiterId);
          return { ...s, waiters };
        }),
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
      const blockedIds = [...removedIds, ...changedIds].filter((id) => {
        const service = state.services.get(id);
        return service !== undefined && isActiveForGraphUpdate(service);
      });
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
        services.set(spec.id, existing ?? initialService(spec, now));
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
 * condition here is a function of state alone, never of `now` against a stored deadline, so
 * replaying this pass for a stale or unrelated event can never surface a new launch or admission
 * on its own; only the dedicated time-driven events (`CooldownElapsed`, `IdleElapsed`,
 * `WaiterExpired`) do that, and the one exception — expiring an already-due waiter instead of
 * admitting it — only fires from within this same pass's own admission step.
 */
const settle = (
  state: LifecycleState,
  now: number,
  commands: ReadonlyArray<LifecycleCommand>,
): readonly [LifecycleState, ReadonlyArray<LifecycleCommand>] => {
  let next = state;
  const emitted: Array<LifecycleCommand> = [...commands];

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
      emitted.push(LifecycleCommand.Launch({ id, generation }));
      next = {
        ...setService(next, id, (s) => ({
          ...s,
          phase: Phase.Starting({ generation, stage: "preparing" }),
          relaunchForced: false,
        })),
        generationCounters: new Map(next.generationCounters).set(id, generation + 1),
      };
      continue;
    }

    if (service.phase._tag === "Running") {
      const generation = service.phase.generation;
      if (prerequisitesSatisfied(next, id) && service.waiters.size > 0) {
        const ready = service.phase.ready;
        const admitted: Array<number> = [];
        const expired: Array<number> = [];
        for (const waiter of service.waiters.values()) {
          if (waiter.requireReady && !ready) continue;
          if (now >= waiter.deadline) expired.push(waiter.id);
          else admitted.push(waiter.id);
        }
        if (admitted.length > 0 || expired.length > 0) {
          for (const waiterId of admitted)
            emitted.push(LifecycleCommand.AdmitConnection({ id, waiterId }));
          for (const waiterId of expired)
            emitted.push(
              LifecycleCommand.FailConnection({
                id,
                waiterId,
                message: `${id} wake budget exceeded while waiting for ${blockingStage(next, id)}`,
                cause: undefined,
              }),
            );
          next = setService(next, id, (s) => {
            const waiters = new Map(s.waiters);
            for (const waiterId of admitted) waiters.delete(waiterId);
            for (const waiterId of expired) waiters.delete(waiterId);
            return { ...s, leases: s.leases + admitted.length, waiters, lastActivity: now };
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
  return settle(applied, now, directCommands);
};

/** A storage operation is admitted only while a service is stopped with no wake armed. */
export const canRunStorage = (state: LifecycleState, id: string): boolean => {
  const service = state.services.get(id);
  return (
    service !== undefined &&
    service.intent === "stopped" &&
    service.phase._tag === "Stopped" &&
    !service.storageReserved
  );
};

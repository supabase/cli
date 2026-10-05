import {
  Cause,
  Clock,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  initialState,
  LifecycleEvent,
  makeGraph,
  reduce,
  waiterBudgetMillis,
  type LifecycleCommand,
  type LifecycleGraph,
  type LifecycleState,
  type ServiceSpec,
} from "./Lifecycle.ts";
import { ServiceError, type ServiceInstance, type ServiceObservation } from "./Service.ts";
import { errorChainMessage } from "./internal/error-message.ts";

export type OrchestratorOperation =
  | "start"
  | "stop"
  | "restart"
  | "destroy"
  | "configure"
  | "register"
  | "storage";

export class OrchestratorError extends Data.TaggedError("OrchestratorError")<{
  readonly operation: OrchestratorOperation;
  readonly message: string;
  readonly cause?: unknown;
  readonly outcomes?: ReadonlyArray<{
    readonly id: string;
    readonly result: Exit.Exit<void, OrchestratorError | ServiceError>;
  }>;
}> {}

/** Summarizes a failure cause as one line per error, including its nested error causes. */
export const causeMessage = (cause: Cause.Cause<unknown>): string =>
  Cause.prettyErrors(cause).map(errorChainMessage).join("; ") || "interrupted";

type ExecutionCore = Pick<
  ServiceInstance<unknown>,
  "get" | "observation" | "stop" | "reprobe" | "storage" | "removeData"
>;

export interface RegisteredInstance {
  readonly id: string;
  /** The service kind this instance runs, for wake observability; the id is the graph identity. */
  readonly service: string;
  readonly core: ExecutionCore;
  /** Resolves the launch configuration from bound inputs and an optional restart candidate, then launches. */
  readonly launch: (
    generation: number,
    inputs: Record<string, string>,
    candidate: unknown,
  ) => Effect.Effect<void, ServiceError>;
  /** Resolves the same configuration as `launch` and only prepares it. */
  readonly prepare: (
    inputs: Record<string, string>,
    candidate: unknown,
  ) => Effect.Effect<void, ServiceError>;
  readonly bind: Effect.Effect<void, ServiceError>;
  readonly close: Effect.Effect<void, ServiceError>;
  readonly hasEndpoint: boolean;
  readonly inputs: ReadonlyArray<string>;
  readonly outputs: Readonly<Record<string, Effect.Effect<string, ServiceError>>>;
}

interface CompositionMember {
  readonly id: string;
  readonly activation: "eager" | "lazy";
  readonly idleMillis?: number;
}

interface CompositionBinding {
  readonly output: string;
  readonly input: string;
}

interface CompositionDependency {
  readonly from: string;
  readonly to: string;
  readonly bindings?: ReadonlyArray<CompositionBinding>;
}

export interface CompositionConfig {
  readonly members: ReadonlyArray<CompositionMember>;
  readonly dependencies: ReadonlyArray<CompositionDependency>;
}

export const CompositionConfig = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      activation: Schema.Literals(["eager", "lazy"]),
      idleMillis: Schema.optionalKey(Schema.Finite),
    }),
  ),
  dependencies: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      bindings: Schema.optionalKey(
        Schema.Array(Schema.Struct({ output: Schema.String, input: Schema.String })),
      ),
    }),
  ),
});

/** One service's lifecycle phase and health from the reducer, joined with its execution facts. */
export interface Status<Config = unknown> extends ServiceObservation<Config> {
  readonly lifecycle: "stopped" | "starting" | "running" | "stopping";
  readonly health: "starting" | "healthy" | "unhealthy" | undefined;
  /** The live generation, if any. */
  readonly launchId: number | undefined;
  /** Whether demand (traffic, a dependent or eager intent) relaunches the service. */
  readonly wakeEnabled: boolean;
  /** Whether a destroy is waiting for the service to stop and its storage to be free, or removing it. */
  readonly destroyPending: boolean;
}

/** An explicit operation the owner may refuse, for example while it drains. */
export type AdmittedOperation = "start" | "restart" | "storage";

/** The lifecycle authority for one stack's registered instances and their composition. */
export interface Interface<Entry extends RegisteredInstance = RegisteredInstance> {
  /** Delivers a service's execution outcome to the lifecycle reducer. */
  readonly report: (event: LifecycleEvent) => Effect.Effect<void>;
  readonly register: (entry: Entry) => Effect.Effect<void, OrchestratorError>;
  readonly get: (id: string) => Effect.Effect<Entry, OrchestratorError>;
  readonly status: (id: string) => Effect.Effect<Status, OrchestratorError>;
  readonly changes: (id: string) => Stream.Stream<Status, OrchestratorError>;
  readonly composition: Effect.Effect<CompositionConfig>;
  /**
   * Validates and installs a composition; a failed `persist` keeps the previous one.
   * `persist` runs under the lifecycle gate, so callers take the cross-process state lock first.
   */
  readonly configure: <E = never>(
    configuration: CompositionConfig,
    persist?: Effect.Effect<void, E>,
  ) => Effect.Effect<void, OrchestratorError | E>;
  readonly start: (id: string) => Effect.Effect<void, OrchestratorError | ServiceError>;
  readonly ready: (id: string) => Effect.Effect<void, OrchestratorError | ServiceError>;
  readonly stop: (id: string) => Effect.Effect<void, OrchestratorError | ServiceError>;
  readonly restart: (
    id: string,
    config?: unknown,
  ) => Effect.Effect<void, OrchestratorError | ServiceError>;
  readonly destroy: (id: string) => Effect.Effect<void, OrchestratorError | ServiceError>;
  /** Runs storage work while the lifecycle keeps the stopped service from launching. */
  readonly storage: <A>(
    id: string,
    operation: Effect.Effect<A, ServiceError>,
  ) => Effect.Effect<A, OrchestratorError | ServiceError>;
  readonly startComposition: Effect.Effect<ReadonlyArray<Status>, OrchestratorError | ServiceError>;
  readonly stopComposition: Effect.Effect<ReadonlyArray<Status>, OrchestratorError | ServiceError>;
  readonly restartComposition: Effect.Effect<
    ReadonlyArray<Status>,
    OrchestratorError | ServiceError
  >;
  readonly stopNamespace: Effect.Effect<void, OrchestratorError | ServiceError>;
  readonly destroyNamespace: Effect.Effect<void, OrchestratorError | ServiceError>;
  /** Admits one unit of traffic, waking the service if needed; the lease lasts for the scope. */
  readonly acquire: (
    id: string,
    awaitReady?: boolean,
    trigger?: string,
  ) => Effect.Effect<void, OrchestratorError | ServiceError, Scope.Scope>;
}

interface Graph {
  readonly members: ReadonlyMap<string, CompositionMember>;
  readonly prerequisites: ReadonlyMap<string, ReadonlyArray<string>>;
}

interface Waiter {
  readonly deferred: Deferred.Deferred<void, ServiceError>;
}

interface Applied {
  readonly before: LifecycleState;
  readonly after: LifecycleState;
  readonly commands: ReadonlyArray<LifecycleCommand>;
}

const graphError = (operation: OrchestratorOperation, message: string, cause?: unknown) =>
  new OrchestratorError({ operation, message, ...(cause === undefined ? {} : { cause }) });

const topo = (
  ids: ReadonlyArray<string>,
  prerequisites: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const result: Array<string> = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const prerequisite of prerequisites.get(id) ?? []) visit(prerequisite);
    result.push(id);
  };
  for (const id of ids) visit(id);
  return result;
};

const validateGraph = (
  configuration: CompositionConfig,
  values: ReadonlyMap<string, RegisteredInstance>,
): Graph | OrchestratorError => {
  const members = new Map<string, CompositionMember>();
  for (const member of configuration.members) {
    if (members.has(member.id)) return graphError("configure", `Duplicate member ${member.id}`);
    members.set(member.id, member);
  }
  const boundInputs = new Set<string>();
  const prerequisites = new Map<string, Array<string>>();
  for (const dependency of configuration.dependencies) {
    const list = prerequisites.get(dependency.to) ?? [];
    if (list.includes(dependency.from))
      return graphError("configure", `Duplicate dependency ${dependency.from}->${dependency.to}`);
    list.push(dependency.from);
    prerequisites.set(dependency.to, list);
    const target = values.get(dependency.to);
    const source = values.get(dependency.from);
    if (source === undefined || target === undefined)
      return graphError("configure", `Dependency references an unregistered instance`);
    for (const binding of dependency.bindings ?? []) {
      if (source.outputs[binding.output] === undefined)
        return graphError("configure", `Unknown output ${dependency.from}.${binding.output}`);
      if (!target.inputs.includes(binding.input))
        return graphError("configure", `Unknown input ${dependency.to}.${binding.input}`);
      const inputKey = `${dependency.to}:${binding.input}`;
      if (boundInputs.has(inputKey))
        return graphError("configure", `Duplicate binding for ${dependency.to}.${binding.input}`);
      boundInputs.add(inputKey);
    }
  }
  for (const member of configuration.members) {
    if (!values.has(member.id))
      return graphError("configure", `Member references an unregistered instance ${member.id}`);
    if (member.activation === "lazy" && !values.get(member.id)?.hasEndpoint)
      return graphError("configure", `Lazy member ${member.id} has no public endpoint`);
    if (member.idleMillis !== undefined && member.idleMillis < 0)
      return graphError("configure", `Negative idle timeout for ${member.id}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): OrchestratorError | undefined => {
    if (visiting.has(id))
      return graphError("configure", "Composition dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of prerequisites.get(id) ?? []) {
      const failure = visit(prerequisite);
      if (failure !== undefined) return failure;
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of values.keys()) {
    const failure = visit(id);
    if (failure !== undefined) return failure;
  }
  return { members, prerequisites };
};

/** Every registered instance as the reducer sees it; a non-member runs as an eager standalone. */
const lifecycleGraph = (ids: Iterable<string>, configuration: CompositionConfig): LifecycleGraph =>
  makeGraph(
    [...ids].map((id): ServiceSpec => {
      const member = configuration.members.find((candidate) => candidate.id === id);
      const prerequisites = configuration.dependencies
        .filter((dependency) => dependency.to === id)
        .map((dependency) => dependency.from);
      return {
        id,
        activation: member?.activation ?? "eager",
        prerequisites,
        ...(member?.idleMillis === undefined ? {} : { idleMillis: member.idleMillis }),
      };
    }),
  );

const lifecycleOf = (state: LifecycleState, id: string): Status["lifecycle"] => {
  const phase = state.services.get(id)?.phase;
  switch (phase?._tag) {
    case "Starting":
      return "starting";
    case "Running":
      return "running";
    case "Stopping":
      return "stopping";
    default:
      return "stopped";
  }
};

const statusOf = <Config>(
  state: LifecycleState,
  id: string,
  execution: ServiceObservation<Config>,
): Status<Config> => {
  const service = state.services.get(id);
  const phase = service?.phase;
  const health =
    phase?._tag === "Starting"
      ? "starting"
      : phase?._tag === "Running"
        ? phase.ready
          ? "healthy"
          : service?.readinessFailure === undefined
            ? "starting"
            : "unhealthy"
        : undefined;
  return {
    ...execution,
    lifecycle: lifecycleOf(state, id),
    health,
    launchId:
      phase === undefined || phase._tag === "Stopped" || phase._tag === "Failed"
        ? undefined
        : phase.generation,
    wakeEnabled: service !== undefined && service.intent !== "stopped",
    destroyPending: service?.destroy !== undefined,
  };
};

const rejectionFor = (
  commands: ReadonlyArray<LifecycleCommand>,
  id: string,
): ServiceError | undefined => {
  const rejected = commands.find(
    (command) => command._tag === "RequestRejected" && command.id === id,
  );
  return rejected?._tag === "RequestRejected"
    ? new ServiceError({ operation: rejected.operation, message: rejected.message })
    : undefined;
};

const cleanupError = (id: string, cause: unknown) =>
  new ServiceError({
    operation: "stop",
    message:
      cause instanceof Error
        ? `${id} cleanup failed: ${errorChainMessage(cause)}`
        : `${id} cleanup failed`,
    cause,
  });

/** Builds an orchestrator whose lifecycle actor, timers and executions live in the current scope. */
export const make = Effect.fn("Orchestrator.make")(function* <Entry extends RegisteredInstance>(
  options: {
    /** Refuses an explicit start, restart or storage operation, checked under the lifecycle gate. */
    readonly admit?: (operation: AdmittedOperation) => Effect.Effect<void, ServiceError>;
  } = {},
): Effect.fn.Return<Interface<Entry>, never, Scope.Scope> {
  const owner = yield* Scope.Scope;
  const admit = options.admit ?? (() => Effect.void);
  // The one lifecycle gate: every reducer step for this owner's graph is applied under it.
  const gate = yield* Semaphore.make(1);
  const lifecycle = yield* SubscriptionRef.make(
    initialState(makeGraph([]), yield* Clock.currentTimeMillis),
  );
  const registry = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map());
  const composition = yield* Ref.make<CompositionConfig>({ members: [], dependencies: [] });
  const waiters = yield* Ref.make<ReadonlyMap<number, Waiter>>(new Map());
  const nextWaiterId = yield* Ref.make(1);
  const candidates = yield* Ref.make<
    ReadonlyMap<string, { readonly minGeneration: number; readonly value: unknown }>
  >(new Map());
  const idleTimers = yield* FiberMap.make<string>();
  // Nothing reduces events once the owner closes, so its pending waiters are released here.
  yield* Scope.addFinalizer(
    owner,
    Ref.get(waiters).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          pending.values(),
          ({ deferred }) =>
            Deferred.fail(
              deferred,
              new ServiceError({ operation: "lifecycle", message: "Lifecycle owner stopped" }),
            ),
          { discard: true },
        ),
      ),
    ),
  );

  const node = Effect.fn("Orchestrator.node")(function* (
    id: string,
  ): Effect.fn.Return<Entry, OrchestratorError> {
    const value = (yield* Ref.get(registry)).get(id);
    if (value === undefined) return yield* graphError("register", `Unknown instance ${id}`);
    return value;
  });

  /**
   * Holds the gate for `effect`. The semaphore hands the permit over and installs its release in
   * one protected step; only the wait for it keeps the caller's interruptibility.
   */
  const withGate = <A, E>(effect: Effect.Effect<A, E>) =>
    gate.withPermit(Effect.uninterruptible(effect));

  const fork = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.forkIn(effect, owner, { uninterruptible: false }).pipe(Effect.asVoid);

  const settleWaiter = (waiterId: number, result: Effect.Effect<void, ServiceError>) =>
    Ref.get(waiters).pipe(
      Effect.flatMap((current) => {
        const waiter = current.get(waiterId);
        return waiter === undefined ? Effect.void : Deferred.complete(waiter.deferred, result);
      }),
    );

  /**
   * Applies events under a gate the caller already holds. Executions and timers are started before
   * the new state is published, so whoever observes a transition also observes its armed timers;
   * waiters are resolved last, once the state they were admitted against is visible.
   */
  const applyLocked = Effect.fnUntraced(function* (events: ReadonlyArray<LifecycleEvent>) {
    const now = yield* Clock.currentTimeMillis;
    const before = yield* SubscriptionRef.get(lifecycle);
    let after = before;
    const commands: Array<LifecycleCommand> = [];
    for (const event of events) {
      const [next, emitted] = reduce(after, event, now);
      after = next;
      commands.push(...emitted);
    }
    const resolvesWaiter = (command: LifecycleCommand) =>
      command._tag === "AdmitConnection" || command._tag === "FailConnection";
    for (const command of commands) if (!resolvesWaiter(command)) yield* execute(command, after);
    yield* SubscriptionRef.set(lifecycle, after);
    for (const command of commands) if (resolvesWaiter(command)) yield* execute(command, after);
    return { before, after, commands } satisfies Applied;
  });

  const dispatch = (events: ReadonlyArray<LifecycleEvent>) => withGate(applyLocked(events));

  const report = (event: LifecycleEvent) => dispatch([event]).pipe(Effect.asVoid);

  /** Executes one `Stop` command; the service reports `Exited` or `StopFailed` itself. */
  const stopGeneration = Effect.fnUntraced(function* (
    id: string,
    generation: number,
    state: LifecycleState,
  ) {
    const service = state.services.get(id);
    const operation =
      service?.intent === "stopped" ? "stop" : service?.relaunchForced ? "restart" : "sleep";
    const discard = service?.destroy !== undefined;
    yield* fork(
      node(id).pipe(
        Effect.flatMap((entry) => entry.core.stop(generation, { operation, discard })),
        Effect.withSpan("Lifecycle.stop", {
          attributes: { instance_id: id, generation, operation },
        }),
      ),
    );
  });

  const resolveInputs = Effect.fn("Orchestrator.resolveInputs")(function* (id: string) {
    const configuration = yield* Ref.get(composition);
    const inputs: Record<string, string> = {};
    for (const dependency of configuration.dependencies.filter(({ to }) => to === id)) {
      const source = yield* node(dependency.from);
      for (const binding of dependency.bindings ?? []) {
        const output = source.outputs[binding.output];
        if (output === undefined)
          return yield* graphError("start", `Unknown output ${dependency.from}.${binding.output}`);
        inputs[binding.input] = yield* output;
      }
    }
    return inputs;
  });

  const launch = Effect.fn("Lifecycle.launch")(function* (id: string, generation: number) {
    yield* Effect.annotateCurrentSpan({ instance_id: id, generation });
    const candidate = yield* Ref.modify(candidates, (current) => {
      const pending = current.get(id);
      if (pending === undefined || generation < pending.minGeneration) return [undefined, current];
      const next = new Map(current);
      next.delete(id);
      return [pending.value, next];
    });
    const started = yield* Effect.gen(function* () {
      const entry = yield* node(id);
      const inputs = yield* resolveInputs(id);
      yield* entry.launch(generation, inputs, candidate);
    }).pipe(Effect.exit);
    if (Exit.isFailure(started) && !Cause.hasInterruptsOnly(started.cause))
      yield* report(
        LifecycleEvent.LaunchFailed({ id, generation, cause: Cause.squash(started.cause) }),
      );
  });

  // Interruptible so re-arming a key never waits out the timer it replaces.
  const sleepThen = (delayMillis: number, event: LifecycleEvent) =>
    Effect.interruptible(Effect.sleep(`${delayMillis} millis`).pipe(Effect.andThen(report(event))));

  /** Resolves waiters in place; every I/O command is forked onto the owner scope. */
  const execute = (command: LifecycleCommand, state: LifecycleState): Effect.Effect<void> => {
    switch (command._tag) {
      case "AdmitConnection":
        return settleWaiter(command.waiterId, Effect.void);
      case "FailConnection": {
        const cause = command.cause;
        // A live session at failure time means the wait ended on readiness, not on the launch.
        const operation =
          state.services.get(command.id)?.phase._tag === "Running"
            ? "readiness"
            : cause instanceof ServiceError
              ? cause.operation
              : "wake";
        return settleWaiter(
          command.waiterId,
          Effect.fail(
            new ServiceError({
              operation,
              message:
                cause instanceof Error
                  ? `${command.message}: ${errorChainMessage(cause)}`
                  : command.message,
              ...(cause === undefined ? {} : { cause }),
            }),
          ),
        );
      }
      case "Launch":
        return fork(launch(command.id, command.generation));
      case "Stop":
        return stopGeneration(command.id, command.generation, state);
      case "Reprobe": {
        const reprobe = node(command.id).pipe(
          Effect.flatMap((entry) => entry.core.reprobe(command.generation)),
          Effect.ignore,
          Effect.withSpan("Lifecycle.reprobe", {
            attributes: { instance_id: command.id, generation: command.generation },
          }),
        );
        if (command.delayMillis === 0) return fork(reprobe);
        // Started at once so the spacing is already timed when the transition is published.
        return Effect.forkIn(
          Effect.sleep(`${command.delayMillis} millis`).pipe(Effect.andThen(reprobe)),
          owner,
          { startImmediately: true, uninterruptible: false },
        ).pipe(Effect.asVoid);
      }
      case "ArmIdleTimer":
        return FiberMap.run(
          idleTimers,
          command.id,
          sleepThen(
            command.delayMillis,
            LifecycleEvent.IdleElapsed({
              id: command.id,
              generation: command.generation,
              epoch: command.epoch,
            }),
          ),
          { startImmediately: true },
        ).pipe(Effect.asVoid);
      case "ArmCooldownTimer":
        return Effect.forkIn(
          sleepThen(
            command.delayMillis,
            LifecycleEvent.CooldownElapsed({ id: command.id, openUntil: command.openUntil }),
          ),
          owner,
          { startImmediately: true, uninterruptible: false },
        ).pipe(Effect.asVoid);
      case "ArmWaiterTimeout":
      case "RequestRejected":
        // The waiting or requesting caller reads these from the commands it dispatched.
        return Effect.void;
    }
  };

  interface Wait {
    readonly id: string;
    readonly requireReady: boolean;
  }

  interface Admission {
    /** Explicit requests dispatched atomically before the waiters; a rejection fails the call. */
    readonly requests?: ReadonlyArray<Extract<LifecycleEvent, { readonly id: string }>>;
    readonly waits: ReadonlyArray<Wait>;
    /** Traffic waits carry a lease and a wake budget; explicit waits carry neither. */
    readonly traffic: boolean;
    /** Checks the owner's admission guard under the same gate step as the requests. */
    readonly operation?: AdmittedOperation;
    /** Runs right after the dispatch, before waiting. */
    readonly onApplied?: (applied: Applied) => Effect.Effect<void>;
    /** Runs uninterruptibly once every wait is admitted, so a lease can't be lost to cancellation. */
    readonly onAdmitted?: Effect.Effect<void>;
  }

  /**
   * Dispatches requests together with one waiter per wait, atomically, then awaits them all. Any
   * failure, rejection or cancellation withdraws the remaining waiters and releases admitted leases.
   */
  const awaitAll = Effect.fnUntraced(function* (admission: Admission) {
    const { waits, traffic } = admission;
    const openedAt = yield* Clock.currentTimeMillis;
    const graph = (yield* SubscriptionRef.get(lifecycle)).graph;
    const bounded = traffic ? waits[0] : undefined;
    // Registration and its unconditional cleanup are installed together, before any wait.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const entries = yield* Effect.forEach(waits, (wait) =>
          Effect.all({
            waiterId: Ref.getAndUpdate(nextWaiterId, (value) => value + 1),
            deferred: Deferred.make<void, ServiceError>(),
          }).pipe(Effect.map((created) => ({ ...wait, ...created }))),
        );
        yield* Ref.update(waiters, (current) => {
          const next = new Map(current);
          for (const { waiterId, deferred } of entries) next.set(waiterId, { deferred });
          return next;
        });
        const forget = Ref.update(waiters, (current) => {
          const next = new Map(current);
          for (const { waiterId } of entries) next.delete(waiterId);
          return next;
        });
        return yield* dispatchAndAwait(admission, entries, openedAt, graph, bounded, restore).pipe(
          Effect.ensuring(forget),
        );
      }),
    );
  });

  /**
   * Dispatches the requests and waiters, then awaits them. Every failure, rejection or
   * cancellation after the dispatch withdraws the waiters and releases granted leases. A traffic
   * wait's budget covers the gate wait and the dispatch too.
   */
  const dispatchAndAwait = Effect.fnUntraced(function* (
    admission: Admission,
    entries: ReadonlyArray<
      Wait & { readonly waiterId: number; readonly deferred: Deferred.Deferred<void, ServiceError> }
    >,
    openedAt: number,
    graph: LifecycleGraph,
    bounded: Wait | undefined,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    const { requests = [], traffic } = admission;
    const withdraw = Effect.gen(function* () {
      yield* dispatch(
        entries.map(({ id, waiterId }) => LifecycleEvent.WaiterCancelled({ id, waiterId })),
      );
      if (!traffic) return;
      for (const { id, deferred } of entries) {
        if (!(yield* Deferred.isDone(deferred))) continue;
        if (Exit.isSuccess(yield* Effect.exit(Deferred.await(deferred))))
          yield* dispatch([LifecycleEvent.ConnectionClosed({ id })]);
      }
    });
    // Set inside the gate, so a failure knows whether there is anything to withdraw.
    const reached = yield* Ref.make(false);
    const guarded = withGate(
      (admission.operation === undefined ? Effect.void : admit(admission.operation)).pipe(
        Effect.andThen(Ref.set(reached, true)),
        Effect.andThen(
          applyLocked([
            ...requests,
            ...entries.map(({ id, waiterId, requireReady }) =>
              traffic
                ? LifecycleEvent.ConnectionOpened({ id, waiterId, requireReady, openedAt })
                : LifecycleEvent.ReadinessAwaited({ id, waiterId, requireReady }),
            ),
          ]),
        ),
      ),
    );
    const dispatched = yield* restore(
      bounded === undefined
        ? guarded
        : guarded.pipe(
            Effect.timeoutOrElse({
              duration: `${waiterBudgetMillis(graph, bounded.id)} millis`,
              orElse: () =>
                Effect.fail(
                  new ServiceError({
                    operation: "wake",
                    message: `${bounded.id} wake budget exceeded while waiting for admission`,
                  }),
                ),
            }),
          ),
    ).pipe(Effect.exit);
    if (Exit.isFailure(dispatched)) {
      if (yield* Ref.get(reached)) yield* withdraw;
      return yield* Effect.failCause(dispatched.cause);
    }
    const applied = dispatched.value;
    for (const request of requests) {
      const rejected = rejectionFor(applied.commands, request.id);
      if (rejected === undefined) continue;
      yield* withdraw;
      return yield* rejected;
    }
    const awaitOne = ({ id, waiterId, deferred }: (typeof entries)[number]) => {
      const timeout = applied.commands.find(
        (command) => command._tag === "ArmWaiterTimeout" && command.waiterId === waiterId,
      );
      if (timeout?._tag !== "ArmWaiterTimeout") return Deferred.await(deferred);
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Deferred.await(deferred).pipe(
            Effect.timeoutOption(`${Math.max(0, timeout.deadline - now)} millis`),
          ),
        ),
        Effect.flatMap((admitted) =>
          Option.isSome(admitted)
            ? Effect.void
            : dispatch([LifecycleEvent.WaiterExpired({ id, waiterId })]).pipe(
                Effect.andThen(Deferred.await(deferred)),
              ),
        ),
      );
    };
    yield* admission.onApplied?.(applied) ?? Effect.void;
    const outcome = yield* restore(
      Effect.forEach(entries, awaitOne, { concurrency: "unbounded", discard: true }).pipe(
        Effect.withSpan("Lifecycle.awaitAdmission", {
          attributes: {
            instance_ids: entries.map(({ id }) => id).join(","),
            traffic,
            waiters: entries.length,
          },
        }),
      ),
    ).pipe(Effect.exit);
    if (Exit.isFailure(outcome)) yield* withdraw;
    else yield* admission.onAdmitted ?? Effect.void;
    return yield* Effect.as(outcome, applied);
  });

  const prerequisitesOf = (state: LifecycleState, id: string): ReadonlyArray<string> =>
    topo(
      [...(state.graph.prerequisiteClosure.get(id) ?? [])],
      new Map([...state.graph.services.values()].map((spec) => [spec.id, spec.prerequisites])),
    );

  /** The readiness waits that bound an explicit operation: every prerequisite, then the target. */
  const explicitWaits = Effect.fnUntraced(function* (id: string, targetReady: boolean) {
    const state = yield* SubscriptionRef.get(lifecycle);
    return [
      ...prerequisitesOf(state, id).map((prerequisite) => ({
        id: prerequisite,
        requireReady: true,
      })),
      { id, requireReady: targetReady },
    ];
  });

  const bindClosure = Effect.fn("Orchestrator.bindClosure")(function* (id: string) {
    const state = yield* SubscriptionRef.get(lifecycle);
    for (const member of [...prerequisitesOf(state, id), id]) yield* (yield* node(member)).bind;
  });

  /** Dispatches one explicit request, failing with the reducer's rejection if it refused it. */
  const request = (event: Extract<LifecycleEvent, { readonly id: string }>) =>
    awaitAll({ requests: [event], waits: [], traffic: false });

  const status = Effect.fn("Orchestrator.status")(function* (id: string) {
    const entry = yield* node(id);
    return statusOf(yield* SubscriptionRef.get(lifecycle), id, yield* entry.core.get);
  });

  const changes = (id: string): Stream.Stream<Status, OrchestratorError> =>
    Stream.unwrap(
      node(id).pipe(
        Effect.map((entry) =>
          Stream.zipLatestWith(
            SubscriptionRef.changes(lifecycle),
            entry.core.observation,
            (state, execution) => statusOf(state, id, execution),
          ),
        ),
      ),
    );

  const start = Effect.fn("Orchestrator.start")(function* (id: string) {
    yield* Effect.annotateCurrentSpan({ instance_id: id });
    yield* node(id);
    yield* bindClosure(id);
    yield* awaitAll({
      requests: [LifecycleEvent.StartRequested({ id })],
      waits: yield* explicitWaits(id, false),
      traffic: false,
      operation: "start",
    });
  });

  const ready = Effect.fn("Orchestrator.ready")(function* (id: string) {
    yield* Effect.annotateCurrentSpan({ instance_id: id });
    yield* node(id);
    yield* awaitAll({ waits: yield* explicitWaits(id, true), traffic: false });
  });

  /** Waits until `generation` is no longer stopping, failing while its cleanup is pending. */
  const awaitStopped = Effect.fnUntraced(function* (id: string, generation: number) {
    const settled = yield* SubscriptionRef.changes(lifecycle).pipe(
      Stream.map((state) => state.services.get(id)),
      Stream.filter(
        (service) =>
          service?.phase._tag !== "Stopping" ||
          service.phase.generation !== generation ||
          service.cleanupFailure !== undefined,
      ),
      Stream.runHead,
    );
    const pending = Option.getOrUndefined(settled)?.cleanupFailure;
    if (pending === undefined) return;
    return yield* cleanupError(id, pending.cause);
  });

  /** Waits until a requested destroy holds the storage reservation, failing on pending cleanup. */
  const awaitDestroyReservation = Effect.fnUntraced(function* (id: string) {
    const settled = yield* SubscriptionRef.changes(lifecycle).pipe(
      Stream.map((state) => state.services.get(id)),
      Stream.filter(
        (service) => service?.destroy !== "requested" || service.cleanupFailure !== undefined,
      ),
      Stream.runHead,
    );
    const service = Option.getOrUndefined(settled);
    if (service?.destroy === "reserved") return;
    if (service?.cleanupFailure !== undefined)
      return yield* cleanupError(id, service.cleanupFailure.cause);
    return yield* new ServiceError({
      operation: "destroy",
      message: `${id} destroy was withdrawn`,
    });
  });

  const stop = Effect.fn("Orchestrator.stop")(function* (id: string) {
    yield* Effect.annotateCurrentSpan({ instance_id: id });
    const entry = yield* node(id);
    const applied = yield* request(LifecycleEvent.StopRequested({ id }));
    const phase = applied.after.services.get(id)?.phase;
    if (phase?._tag === "Stopping")
      yield* awaitStopped(id, phase.generation).pipe(
        Effect.withSpan("Lifecycle.awaitStopped", {
          attributes: { instance_id: id, generation: phase.generation },
        }),
      );
    yield* entry.close;
  });

  const restart = Effect.fn("Orchestrator.restart")(function* (id: string, config?: unknown) {
    yield* Effect.annotateCurrentSpan({ instance_id: id });
    const entry = yield* node(id);
    // A candidate is resolved and prepared before anything stops, so a bad one costs no downtime.
    if (config !== undefined) yield* entry.prepare(yield* resolveInputs(id), config);
    yield* bindClosure(id);
    if (config !== undefined) {
      // Any launch from the restart's own generation onward applies the candidate.
      const minGeneration = (yield* SubscriptionRef.get(lifecycle)).generationCounters.get(id) ?? 1;
      yield* Ref.update(candidates, (current) =>
        new Map(current).set(id, { minGeneration, value: config }),
      );
    }
    // Once admitted, the candidate belongs to the next launch even if this caller's wait fails.
    const admitted = yield* Ref.make(false);
    yield* awaitAll({
      requests: [LifecycleEvent.RestartRequested({ id })],
      waits: yield* explicitWaits(id, false),
      traffic: false,
      operation: "restart",
      onApplied: () => Ref.set(admitted, true),
    }).pipe(
      Effect.tapError(() =>
        Ref.get(admitted).pipe(
          Effect.flatMap((wasAdmitted) =>
            wasAdmitted
              ? Effect.void
              : Ref.update(candidates, (current) => {
                  const next = new Map(current);
                  next.delete(id);
                  return next;
                }),
          ),
        ),
      ),
    );
  });

  const storage = <A>(id: string, operation: Effect.Effect<A, ServiceError>) =>
    Effect.gen(function* () {
      const entry = yield* node(id);
      return yield* Effect.acquireUseRelease(
        awaitAll({
          requests: [LifecycleEvent.StorageReserved({ id })],
          waits: [],
          traffic: false,
          operation: "storage",
        }),
        () => entry.core.storage(operation),
        () => dispatch([LifecycleEvent.StorageReleased({ id })]),
      );
    }).pipe(Effect.withSpan("Orchestrator.storage", { attributes: { instance_id: id } }));

  const unregister = (id: string) =>
    withGate(
      Effect.gen(function* () {
        const values = new Map(yield* Ref.get(registry));
        values.delete(id);
        yield* Ref.set(registry, values);
        const configured = yield* Ref.get(composition);
        const next: CompositionConfig = {
          members: configured.members.filter((member) => member.id !== id),
          dependencies: configured.dependencies.filter(
            (dependency) => dependency.from !== id && dependency.to !== id,
          ),
        };
        yield* Ref.set(composition, next);
        yield* applyLocked([
          LifecycleEvent.DestroyReleased({ id }),
          LifecycleEvent.GraphUpdated({ graph: lifecycleGraph(values.keys(), next) }),
        ]);
      }),
    );

  const destroy = Effect.fn("Orchestrator.destroy")(function* (id: string) {
    yield* Effect.annotateCurrentSpan({ instance_id: id });
    const entry = yield* node(id);
    const configured = yield* Ref.get(composition);
    const dependent = configured.dependencies.find((dependency) => dependency.from === id);
    if (dependent !== undefined)
      return yield* new ServiceError({
        operation: "graph",
        message: `Dependent ${dependent.to} blocks destroy of ${id}`,
      });
    // Any exit short of unregistering gives the destroy up, so the service is usable again.
    yield* Effect.uninterruptibleMask((restore) =>
      restore(
        Effect.gen(function* () {
          yield* request(LifecycleEvent.DestroyRequested({ id }));
          yield* awaitDestroyReservation(id).pipe(
            Effect.withSpan("Lifecycle.awaitDestroyReservation", {
              attributes: { instance_id: id },
            }),
          );
          yield* entry.close;
          yield* entry.core.removeData;
          yield* entry.close;
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? unregister(id)
            : dispatch([LifecycleEvent.DestroyReleased({ id })]),
        ),
      ),
    );
  });

  const settleOutcomes = Effect.fn("Orchestrator.settleOutcomes")(function* (
    operation: "start" | "stop" | "destroy",
    ids: ReadonlyArray<string>,
    action: (id: string) => Effect.Effect<void, OrchestratorError | ServiceError>,
    concurrency: 1 | "unbounded" = 1,
  ) {
    const outcomes = yield* Effect.forEach(
      ids,
      (id) =>
        action(id).pipe(
          Effect.exit,
          Effect.map((result) => ({ id, result })),
        ),
      { concurrency },
    );
    if (outcomes.some(({ result }) => Exit.isFailure(result)))
      return yield* new OrchestratorError({
        operation,
        message: `Composition ${operation} had failures`,
        outcomes,
      });
    return yield* Effect.forEach(ids, status);
  });

  const startComposition = Effect.fn("Orchestrator.startComposition")(function* () {
    const configured = yield* Ref.get(composition);
    const structure = validateGraph(configured, yield* Ref.get(registry));
    if (structure instanceof OrchestratorError) return yield* structure;
    const order = topo(
      configured.members.map((member) => member.id),
      structure.prerequisites,
    );
    const eager = new Set(order.filter((id) => structure.members.get(id)?.activation !== "lazy"));
    const completions = new Map<string, Deferred.Deferred<boolean>>();
    for (const id of order) completions.set(id, yield* Deferred.make<boolean>());
    const bound = new Map<string, Exit.Exit<void, ServiceError | OrchestratorError>>();
    for (const id of order)
      bound.set(
        id,
        yield* node(id).pipe(
          Effect.flatMap((entry) => entry.bind),
          Effect.exit,
        ),
      );
    return yield* settleOutcomes(
      "start",
      order,
      (id) =>
        Effect.gen(function* () {
          const failedPrerequisites: Array<string> = [];
          for (const prerequisite of structure.prerequisites.get(id) ?? []) {
            const completion = completions.get(prerequisite);
            if (completion !== undefined && !(yield* Deferred.await(completion)))
              failedPrerequisites.push(prerequisite);
          }
          const binding = bound.get(id);
          if (binding !== undefined) yield* binding;
          if (!eager.has(id)) {
            yield* awaitAll({
              requests: [LifecycleEvent.ArmRequested({ id })],
              waits: [],
              traffic: false,
              operation: "start",
            });
            return;
          }
          if (failedPrerequisites.length > 0)
            return yield* graphError(
              "start",
              `Blocked by prerequisites: ${failedPrerequisites
                .toSorted((left, right) => order.indexOf(left) - order.indexOf(right))
                .join(", ")}`,
            );
          yield* awaitAll({
            requests: [LifecycleEvent.StartRequested({ id })],
            waits: yield* explicitWaits(id, true),
            traffic: false,
            operation: "start",
          });
        }).pipe(
          Effect.onExit((exit) => {
            const completion = completions.get(id);
            return completion === undefined
              ? Effect.void
              : Deferred.succeed(completion, Exit.isSuccess(exit)).pipe(Effect.asVoid);
          }),
        ),
      "unbounded",
    );
  });

  const stopIds = Effect.fn("Orchestrator.stopIds")(function* (ids: ReadonlyArray<string>) {
    const configured = yield* Ref.get(composition);
    const structure = validateGraph(configured, yield* Ref.get(registry));
    if (structure instanceof OrchestratorError) return yield* structure;
    const order = topo(ids, structure.prerequisites)
      .filter((id) => ids.includes(id))
      .toReversed();
    return yield* settleOutcomes("stop", order, stop);
  });

  const stopComposition = Effect.fn("Orchestrator.stopComposition")(function* () {
    return yield* stopIds((yield* Ref.get(composition)).members.map((member) => member.id));
  });

  const restartComposition = Effect.fn("Orchestrator.restartComposition")(function* () {
    yield* stopIds((yield* Ref.get(composition)).members.map((member) => member.id));
    return yield* startComposition();
  });

  const stopNamespace = Effect.fn("Orchestrator.stopNamespace")(function* () {
    yield* stopIds([...(yield* Ref.get(registry)).keys()]);
  });

  const destroyNamespace = Effect.fn("Orchestrator.destroyNamespace")(function* () {
    const values = yield* Ref.get(registry);
    const structure = validateGraph(yield* Ref.get(composition), values);
    if (structure instanceof OrchestratorError) return yield* structure;
    const order = topo([...values.keys()], structure.prerequisites).toReversed();
    const outcomes = yield* Effect.forEach(order, (id) =>
      destroy(id).pipe(
        Effect.exit,
        Effect.map((result) => ({ id, result })),
      ),
    );
    if (outcomes.some(({ result }) => Exit.isFailure(result)))
      return yield* new OrchestratorError({
        operation: "destroy",
        message: "Composition destroy had failures",
        outcomes,
      });
  });

  const acquire = Effect.fn("Orchestrator.acquire")(function* (
    id: string,
    awaitReady = true,
    trigger?: string,
  ) {
    yield* Effect.annotateCurrentSpan({ instance_id: id, await_ready: awaitReady });
    const entry = yield* node(id);
    const scope = yield* Scope.Scope;
    const initiated = yield* Ref.make(false);
    // The caller that takes a sleeping or failed service out of rest names the wake once.
    const announce = (applied: Applied) => {
      const before = applied.before.services.get(id);
      const after = applied.after.services.get(id);
      const wakes =
        before !== undefined &&
        (before.phase._tag === "Stopped" || before.phase._tag === "Failed") &&
        before.waiters.size === 0 &&
        (after?.waiters.size ?? 0) > 0;
      return wakes
        ? Ref.set(initiated, true).pipe(
            Effect.andThen(
              Effect.logInfo(
                `Waking ${entry.service} ${id}${trigger === undefined ? "" : ` (${trigger})`}`,
              ),
            ),
          )
        : Effect.void;
    };
    yield* awaitAll({
      waits: [{ id, requireReady: awaitReady }],
      traffic: true,
      onApplied: announce,
      onAdmitted: Scope.addFinalizer(scope, dispatch([LifecycleEvent.ConnectionClosed({ id })])),
    }).pipe(
      Effect.tapError((error) =>
        Ref.get(initiated).pipe(
          Effect.flatMap((initiator) =>
            initiator
              ? Effect.logError(
                  error.operation === "readiness"
                    ? `${entry.service} ${id} failed to become ready`
                    : `${entry.service} ${id} failed to wake`,
                  error,
                )
              : Effect.void,
          ),
        ),
      ),
    );
    if (yield* Ref.get(initiated))
      yield* Effect.logInfo(
        awaitReady
          ? `${entry.service} ${id} is ready`
          : `${entry.service} ${id} started (readiness not awaited)`,
      );
  });

  const orchestrator: Interface<Entry> = {
    report,
    register: Effect.fn("Orchestrator.register")(function* (instance) {
      yield* Effect.annotateCurrentSpan({ instance_id: instance.id });
      yield* withGate(
        Effect.gen(function* () {
          const values = yield* Ref.get(registry);
          if (values.has(instance.id))
            return yield* graphError("register", `Duplicate instance ${instance.id}`);
          const next = new Map(values).set(instance.id, instance);
          yield* Ref.set(registry, next);
          yield* applyLocked([
            LifecycleEvent.GraphUpdated({
              graph: lifecycleGraph(next.keys(), yield* Ref.get(composition)),
            }),
          ]);
        }),
      );
    }),
    get: (id) => node(id),
    status,
    changes,
    composition: Ref.get(composition),
    configure: <E = never>(configuration: CompositionConfig, persist?: Effect.Effect<void, E>) =>
      withGate(
        Effect.gen(function* () {
          const previous = yield* Ref.get(composition);
          const values = yield* Ref.get(registry);
          const structure = validateGraph(configuration, values);
          if (structure instanceof OrchestratorError) return yield* structure;
          const affected = new Set([
            ...previous.members.map((member) => member.id),
            ...configuration.members.map((member) => member.id),
            ...[...previous.dependencies, ...configuration.dependencies].flatMap((dependency) => [
              dependency.from,
              dependency.to,
            ]),
          ]);
          const state = yield* SubscriptionRef.get(lifecycle);
          for (const affectedId of affected) {
            const service = state.services.get(affectedId);
            if (
              service !== undefined &&
              (service.intent !== "stopped" || lifecycleOf(state, affectedId) !== "stopped")
            )
              return yield* graphError(
                "configure",
                `Instance ${affectedId} must be stopped and wake-disabled`,
              );
          }
          const update = LifecycleEvent.GraphUpdated({
            graph: lifecycleGraph(values.keys(), configuration),
          });
          // The reducer is pure, so its verdict is known before anything is persisted.
          const [, verdict] = reduce(state, update, yield* Clock.currentTimeMillis);
          const rejected = verdict.find((command) => command._tag === "RequestRejected");
          if (rejected?._tag === "RequestRejected")
            return yield* graphError("configure", rejected.message);
          if (persist !== undefined) yield* persist;
          yield* Ref.set(composition, configuration);
          yield* applyLocked([update]);
        }),
      ).pipe(Effect.withSpan("Orchestrator.configure")),
    start,
    ready,
    stop,
    restart,
    destroy,
    storage,
    startComposition: startComposition(),
    stopComposition: stopComposition(),
    restartComposition: restartComposition(),
    stopNamespace: stopNamespace(),
    destroyNamespace: destroyNamespace(),
    acquire,
  };
  return orchestrator;
});

import {
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Match,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  ServiceError,
  ServiceDestroyed,
  ServiceNotRunning,
  ServiceStaleLaunch,
  type ServiceObservation,
} from "./Service.ts";
import type { ServiceAdmission } from "./Service.ts";

export type OrchestratorOperation =
  | "start"
  | "stop"
  | "restart"
  | "sleep"
  | "destroy"
  | "arm"
  | "bind"
  | "close"
  | "configure"
  | "register"
  | "unregister"
  | "proxy";

export class OrchestratorError extends Data.TaggedError("OrchestratorError")<{
  readonly operation: OrchestratorOperation;
  readonly message: string;
  readonly cause?: unknown;
  readonly outcomes?: ReadonlyArray<{
    readonly id: string;
    readonly result: Exit.Exit<void, OrchestratorError | LifecycleError>;
  }>;
}> {}

type CoreObservation = ServiceObservation<unknown>;

interface RegisteredCore {
  readonly get: Effect.Effect<CoreObservation>;
  readonly ready: Effect.Effect<void, LifecycleError>;
  readonly stop: Effect.Effect<void, LifecycleError>;
  readonly destroy: Effect.Effect<void, LifecycleError>;
  readonly arm: Effect.Effect<void, LifecycleError>;
  readonly armAt: (
    revision: number,
    guard?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, LifecycleError>;
  readonly sleep: Effect.Effect<void, LifecycleError>;
  readonly observation: Stream.Stream<CoreObservation>;
}

export interface RegisteredInstance {
  readonly id: string;
  readonly core: RegisteredCore;
  readonly startAt: (
    revision: number,
    inputs: Record<string, string>,
    wake: boolean,
    guard?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, LifecycleError>;
  readonly restart: (
    revision: number,
    inputs: Record<string, string>,
    config?: unknown,
    guard?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, LifecycleError>;
  readonly bind: Effect.Effect<void, ServiceError>;
  readonly close: Effect.Effect<void, ServiceError>;
  readonly hasEndpoint: boolean;
  readonly inputs: ReadonlyArray<string>;
  readonly outputs: Readonly<Record<string, Effect.Effect<string, ServiceError>>>;
}

export type LifecycleError =
  | ServiceError
  | ServiceDestroyed
  | ServiceNotRunning
  | ServiceStaleLaunch;

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

export interface Interface {
  readonly admissionFor: (
    id: string,
  ) => (
    operation: ServiceAdmission,
    transition: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, ServiceError>;
  readonly register: (
    instance: RegisteredInstance,
  ) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly unregister: (id: string) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly get: (
    id: string,
  ) => Effect.Effect<RegisteredInstance, OrchestratorError | LifecycleError>;
  readonly list: Effect.Effect<
    ReadonlyArray<RegisteredInstance>,
    OrchestratorError | LifecycleError
  >;
  readonly configure: (
    configuration: unknown,
  ) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly start: (id: string) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly stop: (id: string) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly restart: (
    id: string,
    config?: unknown,
  ) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly destroy: (id: string) => Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly startComposition: Effect.Effect<
    ReadonlyArray<CoreObservation>,
    OrchestratorError | LifecycleError
  >;
  readonly stopComposition: Effect.Effect<
    ReadonlyArray<CoreObservation>,
    OrchestratorError | LifecycleError
  >;
  readonly restartComposition: Effect.Effect<
    ReadonlyArray<CoreObservation>,
    OrchestratorError | LifecycleError
  >;
  readonly stopNamespace: Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly destroyNamespace: Effect.Effect<void, OrchestratorError | LifecycleError>;
  readonly acquire: (
    id: string,
    awaitReady?: boolean,
  ) => Effect.Effect<void, OrchestratorError | LifecycleError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@supabase/stack/Orchestrator",
) {}

interface ActivityState {
  readonly active: number;
  readonly lastActivity: number;
}

interface Graph {
  readonly members: ReadonlyMap<string, CompositionMember>;
  readonly prerequisites: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly dependents: ReadonlyMap<string, ReadonlyArray<string>>;
}

interface StartPlan {
  readonly order: ReadonlyArray<string>;
  readonly revisions: ReadonlyMap<string, number>;
  readonly structure: Graph;
  readonly configuration: CompositionConfig;
}

const serviceFailure = (operation: string, message: string): ServiceError =>
  new ServiceError({ operation, message });

const graphError = (operation: OrchestratorOperation, message: string, cause?: unknown) =>
  new OrchestratorError({ operation, message, ...(cause === undefined ? {} : { cause }) });

const isActive = (observation: CoreObservation): boolean =>
  observation.lifecycle !== "stopped" || observation.wakeEnabled;

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

const makeOrchestrator = Effect.gen(function* () {
  const owner = yield* Scope.Scope;
  const graphGate = yield* Semaphore.make(1);
  const idleTimers = yield* FiberMap.make<string>();
  const registry = yield* Ref.make<ReadonlyMap<string, RegisteredInstance>>(new Map());
  const composition = yield* Ref.make<CompositionConfig>({ members: [], dependencies: [] });
  const activity = yield* Ref.make<ReadonlyMap<string, ActivityState>>(new Map());

  const withGraph = Effect.fn("Orchestrator.withGraph")(<A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      restore(graphGate.take(1)).pipe(
        Effect.andThen(effect.pipe(Effect.ensuring(graphGate.release(1)))),
      ),
    ),
  );

  const node = Effect.fn("Orchestrator.node")(function* (
    id: string,
  ): Effect.fn.Return<RegisteredInstance, OrchestratorError> {
    const nodes = yield* Ref.get(registry);
    const value = nodes.get(id);
    if (value === undefined) return yield* graphError("register", `Unknown instance ${id}`);
    return value;
  });

  const graph = (
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
    const dependents = new Map<string, Array<string>>();
    for (const dependency of configuration.dependencies) {
      const list = prerequisites.get(dependency.to) ?? [];
      if (list.includes(dependency.from))
        return graphError("configure", `Duplicate dependency ${dependency.from}->${dependency.to}`);
      list.push(dependency.from);
      prerequisites.set(dependency.to, list);
      const reverse = dependents.get(dependency.from) ?? [];
      reverse.push(dependency.to);
      dependents.set(dependency.from, reverse);
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
    return { members, prerequisites, dependents };
  };

  const configurationGraph = Effect.fn("Orchestrator.configurationGraph")(function* (
    configuration: CompositionConfig,
  ): Effect.fn.Return<Graph, OrchestratorError> {
    const values = yield* Ref.get(registry);
    const result = graph(configuration, values);
    if (result instanceof OrchestratorError) return yield* result;
    return result;
  });

  const operationBlocksDependents = (operation: ServiceAdmission) =>
    Match.value(operation).pipe(
      Match.when("stop", () => true),
      Match.when("restart", () => true),
      Match.when("destroy", () => true),
      Match.when("sleep", () => true),
      Match.when("start", () => false),
      Match.when("storage", () => false),
      Match.when("arm", () => false),
      Match.exhaustive,
    );
  const dependentBlocks = (operation: ServiceAdmission, observation: CoreObservation) =>
    Match.value(operation).pipe(
      Match.when("destroy", () => observation.registered),
      Match.when("sleep", () => observation.lifecycle !== "stopped"),
      Match.when("stop", () => isActive(observation)),
      Match.when("restart", () => isActive(observation)),
      Match.when("start", () => false),
      Match.when("storage", () => false),
      Match.when("arm", () => false),
      Match.exhaustive,
    );
  const admissionFor =
    (id: string) => (operation: ServiceAdmission, transition: Effect.Effect<void, ServiceError>) =>
      withGraph(
        Effect.gen(function* () {
          const configured = yield* Ref.get(composition);
          const structure = yield* configurationGraph(configured);
          const dependents = structure.dependents.get(id) ?? [];
          if (operationBlocksDependents(operation)) {
            for (const dependentId of dependents) {
              const dependent = yield* node(dependentId);
              const observation = yield* dependent.core.get;
              const blocked = dependentBlocks(operation, observation);
              if (blocked)
                return yield* serviceFailure(
                  "graph",
                  `Dependent ${dependentId} blocks ${operation} of ${id}`,
                );
            }
          }
          if (operation === "sleep") {
            const timeout = structure.members.get(id)?.idleMillis;
            const current = (yield* Ref.get(activity)).get(id);
            const now = yield* Clock.currentTimeMillis;
            if (
              timeout === undefined ||
              current === undefined ||
              current.active > 0 ||
              now - current.lastActivity < timeout
            )
              return yield* serviceFailure("graph", `Instance ${id} is not idle`);
          }
          if (operation === "start") {
            for (const prerequisiteId of structure.prerequisites.get(id) ?? []) {
              const prerequisite = yield* node(prerequisiteId);
              const observation = yield* prerequisite.core.get;
              if (observation.lifecycle !== "running" || observation.health !== "healthy")
                return yield* serviceFailure(
                  "graph",
                  `Prerequisite ${prerequisiteId} is not healthy`,
                );
            }
          }
          yield* transition;
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof OrchestratorError ? serviceFailure("graph", error.message) : error,
        ),
      );

  const resolveInputs = Effect.fn("Orchestrator.resolveInputs")(function* (
    id: string,
    configuration: CompositionConfig,
  ): Effect.fn.Return<Record<string, string>, OrchestratorError | LifecycleError> {
    const inputs: Record<string, string> = {};
    const edges = configuration.dependencies.filter((dependency) => dependency.to === id);
    for (const dependency of edges) {
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

  const snapshotPlan = Effect.fn("Orchestrator.snapshotPlan")(function* (
    id: string,
  ): Effect.fn.Return<StartPlan, OrchestratorError> {
    return yield* withGraph(
      Effect.gen(function* () {
        const configuration = yield* Ref.get(composition);
        const configured = yield* configurationGraph(configuration);
        const structure: Graph = configured.members.has(id)
          ? configured
          : {
              members: new Map([...configured.members, [id, { id, activation: "eager" as const }]]),
              prerequisites: configured.prerequisites,
              dependents: configured.dependents,
            };
        const closure = new Set<string>();
        const visit = (member: string) => {
          if (closure.has(member)) return;
          closure.add(member);
          for (const prerequisite of structure.prerequisites.get(member) ?? []) visit(prerequisite);
        };
        visit(id);
        const revisions = new Map<string, number>();
        for (const member of closure) {
          const observation = yield* (yield* node(member)).core.get;
          revisions.set(member, observation.intentRevision);
        }
        return {
          order: topo([...closure], structure.prerequisites),
          revisions,
          structure,
          configuration,
        };
      }),
    );
  });

  const prerequisiteGuard = Effect.fn("Orchestrator.prerequisiteGuard")(function* (
    plan: StartPlan,
    id: string,
  ): Effect.fn.Return<void, ServiceError> {
    if ((yield* Ref.get(composition)) !== plan.configuration)
      return yield* serviceFailure("graph", "Composition changed before admission");
    const values = yield* Ref.get(registry);
    for (const prerequisite of plan.structure.prerequisites.get(id) ?? []) {
      const expected = plan.revisions.get(prerequisite);
      const current = values.get(prerequisite);
      if (expected === undefined || current === undefined)
        return yield* serviceFailure("graph", `Missing prerequisite ${prerequisite}`);
      const observation = yield* current.core.get;
      if (observation.intentRevision !== expected)
        return yield* serviceFailure(
          "graph",
          `Prerequisite ${prerequisite} changed before ${id} admission`,
        );
    }
  });

  const startNode = Effect.fn("Orchestrator.startNode")(function* (
    id: string,
    wake = false,
    awaitTarget = false,
    savedPlan?: StartPlan,
  ): Effect.fn.Return<void, OrchestratorError | LifecycleError> {
    yield* Effect.gen(function* () {
      const plan = savedPlan ?? (yield* snapshotPlan(id));
      for (const member of plan.order) {
        const instance = yield* node(member);
        const inputs = yield* resolveInputs(member, plan.configuration);
        const revision = plan.revisions.get(member);
        if (revision === undefined)
          return yield* graphError("start", `Missing revision for ${member}`);
        yield* instance.startAt(revision, inputs, wake, prerequisiteGuard(plan, member));
        yield* instance.bind;
        if (member !== id || awaitTarget) yield* instance.core.ready;
      }
    });
  });

  const reschedulePrerequisites = Effect.fn("Orchestrator.reschedulePrerequisites")(function* (
    id: string,
  ): Effect.fn.Return<void, OrchestratorError> {
    yield* Effect.gen(function* () {
      const structure = yield* configurationGraph(yield* Ref.get(composition));
      for (const prerequisite of structure.prerequisites.get(id) ?? [])
        yield* scheduleIdle(prerequisite);
    });
  });

  const scheduleIdle = Effect.fn("Orchestrator.scheduleIdle")(function* (
    id: string,
  ): Effect.fn.Return<void, OrchestratorError> {
    yield* Effect.gen(function* () {
      const configured = yield* Ref.get(composition);
      const timeout = configured.members.find((member) => member.id === id)?.idleMillis;
      if (timeout === undefined || timeout < 0) return;
      const now = yield* Clock.currentTimeMillis;
      const current = (yield* Ref.get(activity)).get(id);
      if (current === undefined) return;
      const delay = Math.max(0, timeout - (now - current.lastActivity));
      yield* FiberMap.run(
        idleTimers,
        id,
        Effect.gen(function* () {
          if (delay > 0) yield* Effect.sleep(`${delay} millis`);
          const now = yield* Clock.currentTimeMillis;
          const state = yield* withGraph(
            Effect.gen(function* () {
              const values = yield* Ref.get(activity);
              const current = values.get(id);
              if (
                current === undefined ||
                current.active > 0 ||
                now - current.lastActivity < timeout
              )
                return false;
              yield* Ref.set(activity, new Map(values).set(id, { ...current }));
              return true;
            }),
          );
          if (state) {
            const result = yield* (yield* node(id)).core.sleep.pipe(Effect.exit);
            if (Exit.isSuccess(result)) yield* reschedulePrerequisites(id);
          }
        }),
      );
    });
  });

  const release = Effect.fn("Orchestrator.release")(function* (
    id: string,
  ): Effect.fn.Return<void, OrchestratorError> {
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* withGraph(
        Effect.gen(function* () {
          const values = yield* Ref.get(activity);
          const current = values.get(id);
          if (current === undefined) return;
          yield* Ref.set(
            activity,
            new Map(values).set(id, {
              active: Math.max(0, current.active - 1),
              lastActivity: now,
            }),
          );
        }),
      );
      yield* scheduleIdle(id);
    });
  });

  const settle = Effect.fn("Orchestrator.settle")(function* (
    operation: "start" | "stop" | "destroy",
    ids: ReadonlyArray<string>,
    action: (id: string) => Effect.Effect<void, OrchestratorError | LifecycleError>,
  ): Effect.fn.Return<ReadonlyArray<CoreObservation>, OrchestratorError | LifecycleError> {
    return yield* Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(ids, (id) =>
        action(id).pipe(
          Effect.exit,
          Effect.map((result) => ({ id, result })),
        ),
      );
      if (outcomes.some(({ result }) => Exit.isFailure(result)))
        return yield* new OrchestratorError({
          operation,
          message: `Composition ${operation} had failures`,
          outcomes,
        });
      return yield* Effect.forEach(ids, (id) =>
        node(id).pipe(Effect.flatMap((instance) => instance.core.get)),
      );
    });
  });

  const startComposition = Effect.fn("Orchestrator.startComposition")(
    function* (): Effect.fn.Return<
      ReadonlyArray<CoreObservation>,
      OrchestratorError | LifecycleError
    > {
      const configured = yield* Ref.get(composition);
      const structure = yield* configurationGraph(configured);
      const order = topo(
        configured.members.map((member) => member.id),
        structure.prerequisites,
      );
      const eager = new Set(
        topo(
          [
            ...configured.members
              .filter((member) => member.activation === "eager")
              .map((member) => member.id),
            ...order.filter((id) => !structure.members.has(id)),
          ],
          structure.prerequisites,
        ),
      );
      const plans = new Map<string, StartPlan>();
      const bound = new Map<string, Exit.Exit<void, OrchestratorError | LifecycleError>>();
      for (const id of order) plans.set(id, yield* snapshotPlan(id));
      for (const id of order)
        bound.set(
          id,
          yield* node(id).pipe(
            Effect.flatMap((instance) => instance.bind),
            Effect.exit,
          ),
        );
      return yield* settle("start", order, (id) =>
        Effect.gen(function* () {
          const binding = bound.get(id);
          if (binding !== undefined) yield* binding;
          const instance = yield* node(id);
          const plan = plans.get(id);
          const revision = plan?.revisions.get(id);
          if (plan === undefined || revision === undefined)
            return yield* graphError("start", `Missing plan for ${id}`);
          const policy = structure.members.get(id);
          if (
            policy?.activation === "lazy" ||
            (policy?.idleMillis !== undefined && instance.hasEndpoint)
          )
            yield* instance.core.armAt(revision, prerequisiteGuard(plan, id));
          if (eager.has(id)) {
            const inputs = yield* resolveInputs(id, configured);
            yield* instance.startAt(revision, inputs, false, prerequisiteGuard(plan, id));
            yield* instance.bind;
            yield* instance.core.ready;
          }
        }),
      );
    },
  );

  const stopIds = Effect.fn("Orchestrator.stopIds")(function* (ids: ReadonlyArray<string>) {
    const structure = yield* configurationGraph(yield* Ref.get(composition));
    const order = topo(ids, structure.prerequisites)
      .filter((id) => ids.includes(id))
      .toReversed();
    return yield* settle("stop", order, (id) =>
      Effect.gen(function* () {
        const instance = yield* node(id);
        yield* instance.core.stop;
        yield* instance.close;
        yield* reschedulePrerequisites(id);
      }),
    );
  });

  const destroyNode = Effect.fn("Orchestrator.destroyNode")(function* (id: string) {
    const instance = yield* node(id);
    yield* instance.core.destroy;
    yield* instance.close;
    yield* withGraph(
      Effect.gen(function* () {
        const values = yield* Ref.get(registry);
        const next = new Map(values);
        next.delete(id);
        yield* Ref.set(registry, next);
        const configured = yield* Ref.get(composition);
        yield* Ref.set(composition, {
          members: configured.members.filter((member) => member.id !== id),
          dependencies: configured.dependencies.filter(
            (dependency) => dependency.from !== id && dependency.to !== id,
          ),
        });
      }),
    );
  });

  const stopComposition = Effect.fn("Orchestrator.stopComposition")(function* () {
    const configured = yield* Ref.get(composition);
    return yield* stopIds(configured.members.map((member) => member.id));
  });
  const restartComposition = Effect.fn("Orchestrator.restartComposition")(function* () {
    const configured = yield* Ref.get(composition);
    yield* stopIds(configured.members.map((member) => member.id));
    return yield* startComposition();
  });
  const stopNamespace = Effect.fn("Orchestrator.stopNamespace")(function* () {
    const values = yield* Ref.get(registry);
    yield* stopIds([...values.keys()]);
  });
  const destroyNamespace = Effect.fn("Orchestrator.destroyNamespace")(function* () {
    const values = yield* Ref.get(registry);
    yield* stopIds([...values.keys()]);
    const configured = yield* configurationGraph(yield* Ref.get(composition));
    for (const id of topo([...values.keys()], configured.prerequisites).toReversed())
      yield* destroyNode(id);
  });

  const orchestrator: Interface = {
    admissionFor,
    register: Effect.fn("Orchestrator.register")((instance) =>
      withGraph(
        Effect.gen(function* () {
          const values = yield* Ref.get(registry);
          if (values.has(instance.id))
            return yield* graphError("register", `Duplicate instance ${instance.id}`);
          yield* Ref.set(registry, new Map(values).set(instance.id, instance));
          const seenExit = yield* Ref.make<CoreObservation["exit"]>(undefined);
          const seenHealthy = yield* Ref.make<number | undefined>(undefined);
          yield* Effect.forkIn(
            instance.core.observation.pipe(
              Stream.takeUntil((observation) => !observation.registered),
              Stream.runForEach((observation) =>
                Effect.gen(function* () {
                  if (
                    observation.lifecycle === "running" &&
                    observation.health === "healthy" &&
                    observation.wakeEnabled &&
                    observation.launchId !== (yield* Ref.get(seenHealthy))
                  ) {
                    yield* Ref.set(seenHealthy, observation.launchId);
                    const now = yield* Clock.currentTimeMillis;
                    yield* withGraph(
                      Ref.update(activity, (values) =>
                        new Map(values).set(instance.id, {
                          active: values.get(instance.id)?.active ?? 0,
                          lastActivity: now,
                        }),
                      ),
                    );
                    yield* scheduleIdle(instance.id);
                  }
                  if (observation.exit === undefined) return;
                  if (observation.lifecycle === "stopped") {
                    yield* reschedulePrerequisites(instance.id);
                    return;
                  }
                  if (observation.wakeEnabled) return;
                  if ((yield* Ref.get(seenExit)) === observation.exit) return;
                  yield* Ref.set(seenExit, observation.exit);
                  yield* instance.close.pipe(
                    Effect.tapError((cause) => Effect.logError("Instance close failed", cause)),
                    Effect.ignore,
                  );
                }),
              ),
            ),
            owner,
          );
        }),
      ),
    ),
    unregister: Effect.fn("Orchestrator.unregister")((id) =>
      withGraph(
        Effect.gen(function* () {
          const instance = yield* node(id);
          const observation = yield* instance.core.get;
          if (observation.registered || observation.lifecycle !== "stopped")
            return yield* graphError("unregister", `Instance ${id} must be destroyed first`);
          const structure = yield* configurationGraph(yield* Ref.get(composition));
          if ((structure.dependents.get(id) ?? []).some((dependentId) => dependentId !== id))
            return yield* graphError(
              "unregister",
              `Instance ${id} is still referenced by a dependent`,
            );
          const values = yield* Ref.get(registry);
          const next = new Map(values);
          next.delete(id);
          yield* Ref.set(registry, next);
          const configured = yield* Ref.get(composition);
          yield* Ref.set(composition, {
            members: configured.members.filter((member) => member.id !== id),
            dependencies: configured.dependencies.filter(
              (dependency) => dependency.from !== id && dependency.to !== id,
            ),
          });
        }),
      ),
    ),
    get: Effect.fn("Orchestrator.get")((id) => node(id)),
    list: Ref.get(registry).pipe(Effect.map((values) => [...values.values()])),
    configure: Effect.fn("Orchestrator.configure")((configuration) =>
      Schema.decodeUnknownEffect(CompositionConfig)(configuration).pipe(
        Effect.mapError((cause) => graphError("configure", "Invalid composition", cause)),
        Effect.flatMap((decoded) =>
          withGraph(
            Effect.gen(function* () {
              const previous = yield* Ref.get(composition);
              yield* configurationGraph(decoded);
              const affected = new Set([
                ...previous.members.map((member) => member.id),
                ...decoded.members.map((member) => member.id),
              ]);
              for (const dependency of [...previous.dependencies, ...decoded.dependencies]) {
                affected.add(dependency.from);
                affected.add(dependency.to);
              }
              for (const affectedId of affected) {
                const instance = yield* node(affectedId);
                const observation = yield* instance.core.get;
                if (observation.lifecycle !== "stopped" || observation.wakeEnabled)
                  return yield* graphError(
                    "configure",
                    `Instance ${affectedId} must be stopped and wake-disabled`,
                  );
              }
              yield* Ref.set(composition, decoded);
            }),
          ),
        ),
      ),
    ),
    start: Effect.fn("Orchestrator.start")((id) =>
      Effect.gen(function* () {
        const plan = yield* snapshotPlan(id);
        for (const member of plan.order) yield* (yield* node(member)).bind;
        yield* startNode(id, false, false, plan);
      }),
    ),
    stop: Effect.fn("Orchestrator.stop")((id) =>
      Effect.gen(function* () {
        const instance = yield* node(id);
        yield* instance.core.stop;
        yield* instance.close;
        yield* reschedulePrerequisites(id);
      }),
    ),
    restart: Effect.fn("Orchestrator.restart")((id, config) =>
      Effect.gen(function* () {
        const plan = yield* snapshotPlan(id);
        for (const member of plan.order) yield* (yield* node(member)).bind;
        for (const member of plan.order.slice(0, -1)) {
          const instance = yield* node(member);
          const inputs = yield* resolveInputs(member, plan.configuration);
          const revision = plan.revisions.get(member);
          if (revision === undefined)
            return yield* graphError("restart", `Missing revision for ${member}`);
          yield* instance.startAt(revision, inputs, false, prerequisiteGuard(plan, member));
          yield* instance.bind;
          yield* instance.core.ready;
        }
        const instance = yield* node(id);
        const inputs = yield* resolveInputs(id, plan.configuration);
        const revision = plan.revisions.get(id);
        if (revision === undefined)
          return yield* graphError("restart", `Missing revision for ${id}`);
        yield* instance.restart(revision, inputs, config, prerequisiteGuard(plan, id));
        yield* instance.bind;
      }),
    ),
    destroy: Effect.fn("Orchestrator.destroy")((id) => destroyNode(id)),
    startComposition: startComposition(),
    stopComposition: stopComposition(),
    restartComposition: restartComposition(),
    stopNamespace: stopNamespace(),
    destroyNamespace: destroyNamespace(),
    acquire: Effect.fn("Orchestrator.acquire")((id, awaitReady = true) =>
      Effect.gen(function* () {
        const instance = yield* node(id);
        const scope = yield* Scope.Scope;
        const now = yield* Clock.currentTimeMillis;
        const wake = yield* withGraph(
          Effect.gen(function* () {
            const observation = yield* instance.core.get;
            if (observation.lifecycle === "stopped" && !observation.wakeEnabled)
              return yield* serviceFailure("proxy", `Instance ${id} is explicitly stopped`);
            const values = yield* Ref.get(activity);
            yield* Ref.set(
              activity,
              new Map(values).set(id, {
                active: (values.get(id)?.active ?? 0) + 1,
                lastActivity: now,
              }),
            );
            yield* Scope.addFinalizer(
              scope,
              release(id).pipe(
                Effect.tapError((cause) => Effect.logError("Instance release failed", cause)),
                Effect.ignore,
              ),
            );
            return observation.lifecycle !== "running";
          }),
        );
        if (wake) {
          const plan = yield* snapshotPlan(id);
          for (const member of plan.order) yield* (yield* node(member)).bind;
          yield* startNode(id, true, awaitReady, plan);
        }
        if (awaitReady) yield* instance.core.ready;
      }),
    ),
  };
  return orchestrator;
});

export const layer = Layer.effect(Service, makeOrchestrator.pipe(Effect.map(Service.of)));

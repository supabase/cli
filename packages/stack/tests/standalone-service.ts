import { Effect, Ref } from "effect";
import * as Orchestrator from "../src/Orchestrator.ts";
import { makeService, type ServiceDefinition, type ServiceError } from "../src/Service.ts";

/**
 * Runs one service definition under its own lifecycle authority, as a lazy member with no idle
 * timeout: an explicit start launches it once, and a failed launch is not retried on its own.
 */
export const makeStandaloneService = Effect.fn("Test.makeStandaloneService")(function* <Config>(
  definition: ServiceDefinition<Config>,
  options: { readonly id: string; readonly config: Config },
) {
  const { id } = options;
  const orchestrator = yield* Orchestrator.make();
  const current = yield* Ref.make(options.config);
  const candidate = yield* Ref.make(options.config);
  const core = yield* makeService(definition, {
    id,
    config: options.config,
    report: orchestrator.report,
  });
  // The orchestrator only passes a restart candidate through; the typed value lives here.
  const configFor = (restarted: unknown) =>
    restarted === undefined ? Ref.get(current) : Ref.get(candidate);
  yield* orchestrator.register({
    id,
    service: id,
    core,
    launch: (generation, _inputs, restarted) =>
      configFor(restarted).pipe(
        Effect.tap((config) => Ref.set(current, config)),
        Effect.flatMap((config) => core.launch(generation, config)),
      ),
    prepare: (_inputs, restarted) => configFor(restarted).pipe(Effect.flatMap(core.prepare)),
    bind: Effect.void,
    close: Effect.void,
    confirmRemoved: Effect.void,
    release: Effect.void,
    hasEndpoint: true,
    inputs: [],
    outputs: {},
  });
  yield* orchestrator.configure({ members: [{ id, activation: "lazy" }], dependencies: [] });
  return {
    id,
    get: Effect.all([orchestrator.status(id), core.get]).pipe(
      Effect.map(([status, execution]) => ({ ...status, config: execution.config })),
    ),
    observation: orchestrator.changes(id),
    /** Execution facts that outlive the instance's registration, such as `registered`. */
    execution: core.get,
    start: orchestrator.start(id),
    ready: orchestrator.ready(id),
    stop: orchestrator.stop(id),
    restart: (config?: Config) =>
      config === undefined
        ? orchestrator.restart(id)
        : Ref.set(candidate, config).pipe(Effect.andThen(orchestrator.restart(id, config))),
    destroy: orchestrator.destroy(id),
    storage: <A>(operation: Effect.Effect<A, ServiceError>) => orchestrator.storage(id, operation),
  };
});

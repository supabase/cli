import {
  Context,
  Crypto,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { failureMessage } from "./internal/failure-message.ts";
import * as Network from "./Network.ts";
import type { NetworkEndpoint, NetworkNamespace } from "./Network.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { CompositionConfig } from "./Orchestrator.ts";
import {
  makeService,
  ServiceError,
  type ServiceAdmission,
  type ServiceInstance,
  type ServiceInstanceContext,
  type ServiceObservation,
} from "./Service.ts";
import { ProxyError } from "./Proxy.ts";
import {
  backendAddress,
  credentialsFor,
  endpointNames,
  endpointPort,
  outputsFor,
  publicUrl,
  sharedRoutes,
} from "./host/Endpoints.ts";
import {
  consumesCredentials,
  CredentialError,
  credentialOverrides,
  nextCredentials,
  withCredentials,
  withoutUnusedCredentials,
} from "./host/Credentials.ts";
import {
  makeSupabaseComposition,
  type SupabaseCompositionOptions,
} from "./composition/Supabase.ts";
import {
  makeServiceRecipe,
  requireInputs,
  ServiceCreation,
  serviceSchemas,
  type CatalogRecipe,
  type ServiceCreationInput,
} from "./services/Catalog.ts";
import type { CatalogError } from "./services/Recipe.ts";
import * as Container from "./runtime/Container.ts";
import { stackError, type OwnerRpc } from "./Rpc.ts";
import * as State from "./State.ts";
import type { SavedStack, StackKeysInput } from "./State.ts";
import { makeDockerHelperRegistry } from "./storage/DockerHelperRegistry.ts";

export interface OwnerOptions {
  readonly saved: SavedStack;
  readonly state: State.Interface;
  readonly root: string;
  readonly cacheRoot: string;
}

type OwnerRpcs = RpcGroup.Rpcs<typeof OwnerRpc>;

/** RPC handlers for the owner's instance and composition operations. */
type Handlers = {
  readonly [Current in OwnerRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Rpc.ResultFrom<Current, never>;
};

/** Removes containers labeled with this stack and data root; native stacks own none. */
export const sweepContainers = Effect.fn("Owner.sweepContainers")(function* (
  saved: Pick<SavedStack, "id" | "runtime">,
  root: string,
) {
  if (saved.runtime !== "native")
    yield* Container.removeStackContainers({ engine: saved.runtime, stackId: saved.id, root });
});

type NamespaceError =
  | Orchestrator.OrchestratorError
  | Orchestrator.LifecycleError
  | Network.NetworkError
  | State.StateError
  | Effect.Error<ReturnType<typeof sweepContainers>>;

export interface Interface {
  readonly handlers: Handlers;
  readonly namespace: {
    /** Stops every instance after in-flight definition changes settle, then removes containers. */
    readonly stop: Effect.Effect<void, NamespaceError>;
    /**
     * Destroys every instance once in-flight definition changes settle, then releases owned
     * containers, claims and saved state.
     */
    readonly destroy: Effect.Effect<void, NamespaceError>;
  };
  readonly setDraining: (draining: boolean) => Effect.Effect<void>;
  readonly getServing: Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/Owner") {}

interface Entry extends Orchestrator.RegisteredInstance {
  readonly core: ServiceInstance<ServiceCreation>;
  readonly recipe: CatalogRecipe;
  /** The saved creation, which composition wiring and launches update. */
  readonly creation: Ref.Ref<ServiceCreation>;
  readonly namespace: NetworkNamespace;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serviceError =
  (operation: string) =>
  (cause: unknown): ServiceError =>
    new ServiceError({ operation, message: failureMessage(cause), cause });

const rpcError = (operation: string) =>
  Effect.mapError((cause: unknown) => stackError(operation, cause));

const mergeInputs = (creation: ServiceCreation, inputs: Record<string, string | undefined>) =>
  Schema.decodeUnknownEffect(ServiceCreation)({
    ...creation,
    config: Object.fromEntries(
      Object.entries({ ...creation.config, ...inputs }).filter(([, value]) => value !== undefined),
    ),
  }).pipe(Effect.mapError(serviceError("inputs")));

const restartCreation = (creation: ServiceCreation, candidate: unknown) =>
  candidate === undefined
    ? Effect.succeed(creation)
    : Schema.decodeUnknownEffect(ServiceCreation)({
        ...creation,
        config: isRecord(candidate) && "config" in candidate ? candidate.config : candidate,
      }).pipe(Effect.mapError(serviceError("restart")));

const withoutInstance = (current: SavedStack, id: string): SavedStack =>
  withoutUnusedCredentials({
    ...current,
    instances: current.instances.filter((instance) => instance.id !== id),
    composition: {
      members: current.composition.members.filter((member) => member.id !== id),
      dependencies: current.composition.dependencies.filter(
        (dependency) => dependency.from !== id && dependency.to !== id,
      ),
    },
  });

const drainingBlocks: ReadonlyArray<ServiceAdmission> = ["start", "arm", "restart", "storage"];

const makeOwner = Effect.fn("Owner.make")(function* (options: OwnerOptions) {
  const services = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
    | Scope.Scope
  >();
  const ownerScope = Context.get(services, Scope.Scope);
  const crypto = Context.get(services, Crypto.Crypto);
  const network = yield* Network.Service;
  const orchestrator = yield* Orchestrator.make<Entry>();
  const helpers = yield* makeDockerHelperRegistry(yield* crypto.randomUUIDv4);
  const definitionGate = yield* Semaphore.make(1);
  const draining = yield* Ref.make(false);
  const { id: stackId, runtime } = options.saved;
  const routeKeys = {
    publishableKey: options.saved.credentials?.publishableKey ?? "",
    secretKey: options.saved.credentials?.secretKey ?? "",
    anonKey: options.saved.credentials?.anonKey ?? "",
    serviceRoleKey: options.saved.credentials?.serviceRoleKey ?? "",
  };

  const rejectWhileDraining = Ref.get(draining).pipe(
    Effect.flatMap((isDraining) =>
      isDraining
        ? Effect.fail(new ServiceError({ operation: "draining", message: "Owner is draining" }))
        : Effect.void,
    ),
  );

  // Mask only the permit handoff; admitted definition changes belong to the owner scope. A change
  // arriving while draining fails before waiting behind the shutdown that holds the permit.
  const definitionChange = <A, E>(work: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* rejectWhileDraining;
        yield* restore(definitionGate.take(1));
        const fiber = yield* Effect.forkIn(
          rejectWhileDraining.pipe(
            Effect.andThen(work),
            Effect.ensuring(definitionGate.release(1)),
          ),
          ownerScope,
          { uninterruptible: false },
        );
        return yield* restore(Fiber.join(fiber));
      }),
    );

  const readSaved = options.state
    .read(stackId)
    .pipe(
      Effect.flatMap((saved) =>
        saved === undefined
          ? Effect.fail(
              new State.StateError({ operation: "read", message: "Saved stack is missing" }),
            )
          : Effect.succeed(saved),
      ),
    );
  const updateState = (update: (current: SavedStack) => SavedStack) =>
    options.state.withLock(
      readSaved.pipe(Effect.flatMap((current) => options.state.save(update(current)))),
    );

  const requireStopped = (configuration: CompositionConfig) =>
    Effect.forEach(
      new Set([
        ...configuration.members.map(({ id }) => id),
        ...configuration.dependencies.flatMap(({ from, to }) => [from, to]),
      ]),
      (id) =>
        orchestrator.get(id).pipe(
          Effect.flatMap((entry) => entry.core.get),
          Effect.flatMap(({ lifecycle, wakeEnabled }) =>
            lifecycle === "stopped" && !wakeEnabled
              ? Effect.void
              : Effect.fail(
                  new CredentialError({
                    message: `Service ${id} must be stopped with wake disabled before stack credentials change`,
                  }),
                ),
          ),
        ),
      { discard: true },
    );

  const resolveStackCredentials = Effect.fn("Owner.resolveStackCredentials")(function* (
    overrides: Effect.Success<ReturnType<typeof credentialOverrides>>,
    keys?: StackKeysInput,
  ) {
    const credentials = yield* options.state.withLock(
      Effect.gen(function* () {
        const current = yield* readSaved;
        const next = yield* nextCredentials(current, overrides, keys);
        if (next === current.credentials) return next;
        if (current.credentials !== undefined) yield* requireStopped(current.composition);
        yield* options.state.save({ ...current, credentials: next });
        return next;
      }),
    );
    Object.assign(routeKeys, credentials);
    return credentials;
  });

  const resolveCredentials = Effect.fn("Owner.resolveCredentials")(function* (
    creation: ServiceCreationInput,
  ) {
    if (!consumesCredentials(creation))
      return yield* Schema.decodeUnknownEffect(ServiceCreation)(creation);
    const credentials = yield* resolveStackCredentials(yield* credentialOverrides([creation]));
    return yield* withCredentials(creation, credentials);
  });

  const recipeFor = (creation: ServiceCreation, id: string) =>
    makeServiceRecipe(creation, {
      stackId,
      instanceId: id,
      root: options.root,
      cacheRoot: options.cacheRoot,
      runtime,
      helpers,
    }).pipe(Effect.provideContext(services));

  const persistCreation = (entry: Pick<Entry, "id" | "creation">, creation: ServiceCreation) =>
    updateState((current) => ({
      ...current,
      instances: current.instances.map((instance) =>
        instance.id === entry.id ? { ...instance, creation } : instance,
      ),
    })).pipe(Effect.andThen(Ref.set(entry.creation, creation)));

  const register = Effect.fn("Owner.register")(function* (id: string, recipe: CatalogRecipe) {
    if (Option.isSome(yield* orchestrator.get(id).pipe(Effect.option)))
      return yield* new Orchestrator.OrchestratorError({
        operation: "register",
        message: `Duplicate instance ${id}`,
      });
    const initial = recipe.creation;
    const creation = yield* Ref.make(initial);
    const namespaceRef = yield* Ref.make<NetworkNamespace | undefined>(undefined);
    const core = yield* makeService(
      {
        ...recipe.definition,
        launch: (context) =>
          persistCreation({ id, creation }, context.config).pipe(
            Effect.mapError(serviceError("state")),
            Effect.andThen(recipe.definition.launch(context)),
          ),
        removeData: (context) =>
          recipe.definition.removeData(context).pipe(
            Effect.andThen(
              Ref.get(namespaceRef).pipe(
                Effect.flatMap((namespace) => namespace?.release ?? Effect.void),
                Effect.mapError(serviceError("release")),
              ),
            ),
            Effect.andThen(
              updateState((current) => withoutInstance(current, id)).pipe(
                Effect.mapError(serviceError("state")),
              ),
            ),
          ),
      },
      {
        id,
        config: initial,
        coordinate: (operation, transition) =>
          (drainingBlocks.includes(operation) ? rejectWhileDraining : Effect.void).pipe(
            Effect.andThen(orchestrator.admissionFor(id)(operation, transition)),
          ),
      },
    ).pipe(Effect.provideService(Scope.Scope, ownerScope));
    const enabled = core.get.pipe(
      Effect.map(
        (observation) =>
          observation.registered &&
          observation.lifecycle !== "stopped" &&
          !(observation.exit !== undefined && !observation.wakeEnabled),
      ),
    );
    const endpoints = Object.fromEntries(
      endpointNames(initial).map((name) => {
        const shared = sharedRoutes(initial, name, routeKeys);
        const endpoint: NetworkEndpoint = {
          protocol: name === "http" ? "http" : "tcp",
          port: endpointPort(initial, name),
          backend: orchestrator.acquire(id, name !== "inspector").pipe(
            Effect.andThen(recipe.endpoint(name)),
            Effect.flatMap(backendAddress),
            Effect.mapError((cause) =>
              cause instanceof ProxyError
                ? cause
                : new ProxyError({ message: cause.message, cause }),
            ),
          ),
          enabled,
          ...(shared === undefined ? {} : { shared }),
        };
        return [name, endpoint];
      }),
    );
    const namespace = yield* network.register({ id, endpoints });
    yield* Ref.set(namespaceRef, namespace);
    const entry: Entry = {
      id,
      core,
      recipe,
      creation,
      namespace,
      startAt: (revision, inputs, wake, guard) =>
        Ref.get(creation).pipe(
          Effect.flatMap((current) => mergeInputs(current, inputs)),
          Effect.flatMap(requireInputs),
          Effect.flatMap((candidate) => core.startAt(revision, candidate, wake, guard)),
        ),
      restart: (revision, inputs, candidate, guard) =>
        Ref.get(creation).pipe(
          Effect.flatMap((current) => restartCreation(current, candidate)),
          Effect.flatMap((next) => mergeInputs(next, inputs)),
          Effect.flatMap(requireInputs),
          Effect.flatMap((next) => core.restart(next, revision, guard)),
        ),
      bind: namespace.bind.pipe(Effect.mapError(serviceError("bind"))),
      close: namespace.close.pipe(Effect.mapError(serviceError("close"))),
      hasEndpoint: endpointNames(initial).length > 0,
      inputs: Object.keys(serviceSchemas[initial.service].fields),
      outputs: Object.fromEntries(
        Object.entries(outputsFor(initial, Ref.get(creation), namespace.address)).map(
          ([name, output]) => [name, output.pipe(Effect.mapError(serviceError("output")))],
        ),
      ),
    };
    yield* orchestrator
      .register(entry)
      .pipe(Effect.catch((cause) => namespace.release.pipe(Effect.andThen(Effect.fail(cause)))));
  });

  for (const saved of options.saved.instances)
    yield* register(saved.id, yield* recipeFor(saved.creation, saved.id));
  yield* orchestrator.configure(options.saved.composition);

  const removeSaved = (id: string) => updateState((current) => withoutInstance(current, id));

  const addInstance = Effect.fn("Owner.addInstance")(function* (creation: ServiceCreation) {
    const id = yield* crypto.randomUUIDv4;
    const rollback = <E>(cause: E) => removeSaved(id).pipe(Effect.andThen(Effect.fail(cause)));
    const recipe = yield* recipeFor(creation, id);
    yield* updateState((current) => ({
      ...current,
      instances: [...current.instances, { id, creation }],
    })).pipe(Effect.andThen(register(id, recipe)), Effect.catch(rollback), Effect.uninterruptible);
    return { id, creation };
  });

  type ComposeError =
    | Effect.Error<ReturnType<typeof addInstance>>
    | Orchestrator.LifecycleError
    | Network.NetworkError;

  const configure = (configuration: CompositionConfig) =>
    options.state.withLock(
      orchestrator.configure(
        configuration,
        readSaved.pipe(
          Effect.flatMap((current) =>
            options.state.save({ ...current, composition: configuration }),
          ),
        ),
      ),
    );

  // A failed cleanup must not replace the failure that triggered it.
  const clearUnusedCredentials = updateState(withoutUnusedCredentials).pipe(
    Effect.catch((cause) => Effect.logWarning("Unused stack credentials were not cleared", cause)),
  );
  const compose = Effect.fn("Owner.compose")(
    function* (
      inputs: ReadonlyArray<ServiceCreationInput>,
      compositionOptions: SupabaseCompositionOptions,
    ) {
      yield* resolveStackCredentials(yield* credentialOverrides(inputs), compositionOptions.keys);
      const creations = yield* Effect.forEach(inputs, resolveCredentials);
      return yield* makeSupabaseComposition<ComposeError>(
        {
          currentComposition: orchestrator.composition,
          get: (id) =>
            orchestrator.get(id).pipe(
              Effect.flatMap((entry) => Ref.get(entry.creation)),
              Effect.map((creation) => ({ id, creation })),
            ),
          status: (id) => orchestrator.get(id).pipe(Effect.flatMap((entry) => entry.core.get)),
          create: addInstance,
          destroy: orchestrator.destroy,
          bind: (id) => orchestrator.get(id).pipe(Effect.flatMap((entry) => entry.bind)),
          address: (id, endpoint, from) =>
            orchestrator.get(id).pipe(
              Effect.flatMap((entry) => entry.namespace.address(endpoint, from)),
              Effect.map(({ host, port }) => publicUrl(host, port)),
            ),
          output: (id, name) =>
            orchestrator
              .get(id)
              .pipe(
                Effect.flatMap(
                  (entry) =>
                    entry.outputs[name] ??
                    Effect.fail(
                      new ServiceError({ operation: "output", message: `Missing output ${name}` }),
                    ),
                ),
              ),
          updateCreation: (id, values) =>
            Effect.gen(function* () {
              const entry = yield* orchestrator.get(id);
              const creation = yield* mergeInputs(yield* Ref.get(entry.creation), values);
              yield* persistCreation(entry, creation);
              return { id, creation };
            }),
          replaceCreation: (id, creation) =>
            Effect.gen(function* () {
              const entry = yield* orchestrator.get(id);
              if (creation.service !== (yield* Ref.get(entry.creation)).service)
                return yield* new ServiceError({
                  operation: "compose",
                  message: `Reused service ${id} cannot change service kind`,
                });
              yield* persistCreation(entry, creation);
              return { id, creation };
            }),
          configure,
        },
        creations,
        compositionOptions,
      );
    },
    Effect.catch((cause) => clearUnusedCredentials.pipe(Effect.andThen(Effect.fail(cause)))),
  );

  const restart = Effect.fn("Owner.restart")(function* (
    id: string,
    input: ServiceCreationInput | undefined,
  ) {
    if (input === undefined) return yield* orchestrator.restart(id);
    const previous = yield* Ref.get((yield* orchestrator.get(id)).creation);
    const next = yield* resolveCredentials(input);
    if (next.service !== previous.service)
      return yield* new ServiceError({
        operation: "restart",
        message: "Service kind cannot change",
      });
    return yield* orchestrator.restart(id, next);
  });

  const observe = (entry: Entry, value: ServiceObservation<ServiceCreation>) =>
    Effect.all({ config: Ref.get(entry.creation), endpoints: entry.namespace.bindings }).pipe(
      Effect.map((current) => ({ ...value, ...current })),
    );
  const observation = (id: string) =>
    orchestrator
      .get(id)
      .pipe(
        Effect.flatMap((entry) =>
          entry.core.get.pipe(Effect.flatMap((value) => observe(entry, value))),
        ),
      );
  const observeAll = (values: ReadonlyArray<{ readonly id: string }>) =>
    Effect.forEach(values, ({ id }) => observation(id));

  const databaseData = Effect.fn("Owner.databaseData")(function* <A>(
    id: string,
    select: (
      recipe: CatalogRecipe,
    ) =>
      | ((context: ServiceInstanceContext<ServiceCreation>) => Effect.Effect<A, CatalogError>)
      | undefined,
  ) {
    const entry = yield* orchestrator.get(id);
    const action = select(entry.recipe);
    if (action === undefined)
      return yield* new ServiceError({
        operation: "storage",
        message: "Snapshots and data reset are only supported for databases",
      });
    return yield* entry.core.storage(
      Effect.acquireUseRelease(
        Scope.make("parallel"),
        (scope) =>
          Ref.get(entry.creation).pipe(
            Effect.flatMap((config) => action({ id, config, scope })),
            Effect.mapError(serviceError("storage")),
          ),
        (scope, exit) => Scope.close(scope, exit),
      ),
    );
  });

  const handlers: Handlers = {
    createService: (input) =>
      definitionChange(
        Effect.gen(function* () {
          const introduced = (yield* readSaved).credentials === undefined;
          // Credentials a failed creation introduced must not pin a retry to its values.
          return yield* resolveCredentials(input).pipe(
            Effect.flatMap(addInstance),
            Effect.catch((cause) =>
              (introduced ? clearUnusedCredentials : Effect.void).pipe(
                Effect.andThen(Effect.fail(cause)),
              ),
            ),
          );
        }),
      ).pipe(rpcError("createService")),
    startService: ({ id }) => orchestrator.start(id).pipe(rpcError("startService")),
    readyService: ({ id }) =>
      orchestrator.get(id).pipe(
        Effect.flatMap((entry) => entry.core.ready),
        rpcError("readyService"),
      ),
    stopService: ({ id }) => orchestrator.stop(id).pipe(rpcError("stopService")),
    // A config-changing restart can adopt saved credentials, so it serializes with definition
    // changes that introduce or roll them back.
    restartService: ({ id, config }) =>
      (config === undefined ? restart(id, config) : definitionChange(restart(id, config))).pipe(
        rpcError("restartService"),
      ),
    destroyService: ({ id }) =>
      definitionChange(orchestrator.destroy(id)).pipe(rpcError("destroyService")),
    prepareService: ({ id }) =>
      orchestrator.get(id).pipe(
        Effect.flatMap((entry) =>
          Ref.get(entry.creation).pipe(
            Effect.flatMap(
              (creation) => entry.recipe.definition.prepare?.(creation) ?? Effect.void,
            ),
          ),
        ),
        rpcError("prepareService"),
      ),
    status: ({ id }) => observation(id).pipe(rpcError("status")),
    followStatus: ({ id }) =>
      Stream.unwrap(
        orchestrator
          .get(id)
          .pipe(
            Effect.map((entry) =>
              entry.core.observation.pipe(Stream.mapEffect((value) => observe(entry, value))),
            ),
          ),
      ).pipe(Stream.mapError((cause) => stackError("followStatus", cause))),
    logs: ({ id }) =>
      Stream.unwrap(orchestrator.get(id).pipe(Effect.map((entry) => entry.recipe.logs))).pipe(
        Stream.map(({ stream, bytes }) => ({ stream, bytes })),
        Stream.mapError((cause) => stackError("logs", cause)),
      ),
    credentials: ({ id, from }) =>
      orchestrator.get(id).pipe(
        Effect.flatMap((entry) =>
          Ref.get(entry.creation).pipe(
            Effect.flatMap((creation) => credentialsFor(creation, entry.namespace.address, from)),
          ),
        ),
        rpcError("credentials"),
      ),
    saveSnapshot: ({ id, key, scope = "cache" }) =>
      databaseData(id, ({ saveDatabaseSnapshot: save }) =>
        save === undefined ? undefined : (context) => save(context, key, scope),
      ).pipe(rpcError("saveSnapshot")),
    restoreSnapshot: ({ id, key, scope = "cache" }) =>
      databaseData(id, ({ restoreDatabaseSnapshot: restore }) =>
        restore === undefined ? undefined : (context) => restore(context, key, scope),
      ).pipe(rpcError("restoreSnapshot")),
    resetData: ({ id }) =>
      databaseData(id, ({ resetDatabaseData }) => resetDatabaseData).pipe(rpcError("resetData")),
    supabaseComposition: ({ services, reuseIds, keys, eager }) =>
      definitionChange(compose(services, { reuseIds, keys, eager })).pipe(
        rpcError("supabaseComposition"),
      ),
    configureComposition: (configuration) =>
      definitionChange(configure(configuration)).pipe(rpcError("configureComposition")),
    startComposition: () =>
      orchestrator.startComposition.pipe(Effect.flatMap(observeAll), rpcError("startComposition")),
    stopComposition: () =>
      orchestrator.stopComposition.pipe(Effect.flatMap(observeAll), rpcError("stopComposition")),
    restartComposition: () =>
      orchestrator.restartComposition.pipe(
        Effect.flatMap(observeAll),
        rpcError("restartComposition"),
      ),
  };

  const sweep = sweepContainers(options.saved, options.root).pipe(Effect.provideContext(services));
  return {
    handlers,
    namespace: {
      stop: orchestrator.stopNamespace.pipe(
        Effect.andThen(sweep),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.stopNamespace"),
      ),
      destroy: orchestrator.destroyNamespace.pipe(
        Effect.andThen(network.release),
        Effect.andThen(sweep),
        Effect.andThen(options.state.remove(stackId)),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.destroyNamespace"),
      ),
    },
    setDraining: (value) => Ref.set(draining, value),
    getServing: Ref.get(draining).pipe(Effect.map((isDraining) => !isDraining)),
  } satisfies Interface;
});

export const layer = (options: Omit<OwnerOptions, "state">) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* State.Service;
      return Service.of(yield* makeOwner({ ...options, state }));
    }),
  ).pipe(
    Layer.provide(
      Network.layer({
        stackId: options.saved.id,
        runtime: options.saved.runtime,
      }),
    ),
  );

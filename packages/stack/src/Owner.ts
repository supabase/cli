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
  SubscriptionRef,
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
  type ServiceInstance,
  type ServiceInstanceContext,
} from "./Service.ts";
import { ProxyError } from "./Proxy.ts";
import {
  backendAddress,
  credentialsFor,
  endpointNames,
  endpointPort,
  joinRoutes,
  outputsFor,
  publicUrl,
  sharedRoutes,
} from "./host/Endpoints.ts";
import {
  consumesCredentials,
  CredentialError,
  credentialOverrides,
  nextCredentials,
  refreshCredentials,
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
import { projectSegmentFor } from "./identity/Identity.ts";
import { stackError, type OwnerRpc } from "./Rpc.ts";
import { confirmStackDataRoot } from "./namespace/Paths.ts";
import * as StackNamespace from "./StackNamespace.ts";
import type { SavedStack, StackCredentials, StackKeysInput } from "./StackNamespace.ts";
import { makeDockerHelperRegistry } from "./storage/DockerHelperRegistry.ts";
import * as LogForwarder from "./host/LogForwarder.ts";
import * as LogflareStorage from "./host/LogflareStorage.ts";
import * as LogStore from "./host/LogStore.ts";

export interface OwnerOptions {
  readonly saved: SavedStack;
  readonly state: StackNamespace.Interface;
  readonly root: string;
  readonly cacheRoot: string;
  /** Shares one host-gateway probe with the host's other container runtimes. */
  readonly hostGateway?: Container.HostGateway;
  /** The engine endpoint and identity resolved once at startup; absent for a native stack. */
  readonly engineTarget?: Container.EngineTarget;
  /**
   * Reads whether shutdown has begun. The host owns that one-way fact; an owner built without a
   * host (for example a sweep) never drains and so admits all work.
   */
  readonly draining?: Effect.Effect<boolean>;
}

type OwnerRpcs = RpcGroup.Rpcs<typeof OwnerRpc>;

/** RPC handlers for the owner's instance and composition operations. */
type Handlers = {
  readonly [Current in OwnerRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Rpc.ResultFrom<Current, never>;
};

/**
 * Removes every container carrying this stack's identity and data-root labels through the
 * owner's pinned engine target. A container that survives removal fails the sweep, so the caller
 * (startup, stop, or destroy) can report it and retry instead of proceeding as if the stack were
 * fully torn down.
 */
export const sweepContainers = Effect.fn("Owner.sweepContainers")(function* (
  saved: Pick<SavedStack, "id">,
  root: string,
  target: Container.EngineTarget | undefined,
) {
  const path = yield* Path.Path;
  if (target === undefined) return;
  const remaining = yield* Container.removeStackContainers({
    target,
    stackId: saved.id,
    stackRoot: path.resolve(root),
  });
  if (remaining.length > 0)
    return yield* new StackNamespace.NamespaceError({
      operation: "cleanup",
      message: `Containers remain: ${remaining.join(", ")}`,
    });
});

type NamespaceError =
  | Orchestrator.OrchestratorError
  | ServiceError
  | Network.NetworkError
  | StackNamespace.NamespaceError
  | Effect.Error<ReturnType<typeof sweepContainers>>;

export interface Interface {
  readonly handlers: Handlers;
  readonly getStackCredentials: Effect.Effect<
    StackCredentials,
    StackNamespace.NamespaceError | CredentialError
  >;
  readonly namespace: {
    /** Stops every instance after in-flight definition changes settle, then removes containers. */
    readonly stop: Effect.Effect<void, NamespaceError>;
    /**
     * Destroys every instance once in-flight definition changes settle, then releases owned
     * containers, native socket directories and saved state.
     */
    readonly destroy: Effect.Effect<void, NamespaceError>;
    /**
     * Stops what this owner launched once in-flight definition changes settle, for an owner whose
     * claim on the stack ended: containers, data, ports and saved state may now belong to a
     * successor and stay untouched.
     */
    readonly release: Effect.Effect<void, NamespaceError>;
  };
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
    composition: Orchestrator.withoutMember(current.composition, id),
  });

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
  const path = Context.get(services, Path.Path);
  const fs = Context.get(services, FileSystem.FileSystem);
  const network = yield* Network.Service;
  // Everything under the data root belongs to the stack, including what a killed owner left
  // mid-command (`jobs/`); the directory itself stays for `Registry.pruneDestroyed`.
  const removeDataRootEntries = fs.exists(options.root).pipe(
    Effect.flatMap((exists) => (exists ? fs.readDirectory(options.root) : Effect.succeed([]))),
    Effect.flatMap((names) =>
      Effect.forEach(
        names,
        (name) => fs.remove(path.join(options.root, name), { recursive: true, force: true }),
        { discard: true },
      ),
    ),
    Effect.mapError(serviceError("cleanup")),
  );
  const rejectWhileDraining = (options.draining ?? Effect.succeed(false)).pipe(
    Effect.flatMap((isDraining) =>
      isDraining
        ? Effect.fail(new ServiceError({ operation: "draining", message: "Owner is draining" }))
        : Effect.void,
    ),
  );
  const orchestrator = yield* Orchestrator.make<Entry>({ admit: () => rejectWhileDraining });
  const helpers = yield* makeDockerHelperRegistry(yield* crypto.randomUUIDv4);
  const logStore = yield* LogStore.make({
    root: StackNamespace.stackLogsRoot(path, options.state.root, options.saved.id),
  }).pipe(Effect.provideContext(services));
  /** The database Analytics stores events in, as the host reaches it. */
  const analyticsDatabase = (analyticsId: string) =>
    Effect.gen(function* () {
      const creation = yield* Ref.get((yield* orchestrator.get(analyticsId)).creation);
      const databaseUrl =
        creation.service === "analytics" ? creation.config.databaseUrl : undefined;
      if (databaseUrl === undefined)
        return yield* new ServiceError({
          operation: "analytics",
          message: "Analytics has no database URL",
        });
      const dependency = (yield* orchestrator.composition).dependencies.find(
        ({ to, bindings }) =>
          to === analyticsId && bindings?.some(({ input }) => input === "databaseUrl") === true,
      );
      const bound =
        dependency === undefined
          ? undefined
          : yield* (yield* orchestrator.get(dependency.from)).recipe.endpoint("sql");
      return yield* LogflareStorage.analyticsDatabase(databaseUrl, bound);
    });
  const forwarder = yield* LogForwarder.make({
    composition: orchestrator.composition,
    logs: logStore,
    storedEvents: (analytics) => LogflareStorage.make(analyticsDatabase(analytics.id)),
  }).pipe(Effect.provideContext(services));
  const definitionGate = yield* Semaphore.make(1);
  const { id: stackId, runtime } = options.saved;
  const project = projectSegmentFor(options.saved.identity, path);
  const routeKeys = {
    publishableKey: options.saved.credentials?.publishableKey ?? "",
    secretKey: options.saved.credentials?.secretKey ?? "",
    anonKey: options.saved.credentials?.anonKey ?? "",
    serviceRoleKey: options.saved.credentials?.serviceRoleKey ?? "",
  };

  // Admitted definition changes run in the owner scope, so a caller cancelled after admission
  // detaches from them; one still queued for the permit is withdrawn. A change arriving while
  // draining fails before waiting behind the shutdown that holds the permit.
  const definitionChange = <A, E>(work: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      yield* rejectWhileDraining;
      const claim = yield* Ref.make<"queued" | "admitted" | "withdrawn">("queued");
      const settle = (to: "admitted" | "withdrawn") =>
        Ref.modify(claim, (current) => (current === "queued" ? [true, to] : [false, current]));
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const worker = yield* Effect.forkIn(
            definitionGate.withPermit(
              settle("admitted").pipe(
                Effect.flatMap((admitted) =>
                  admitted
                    ? rejectWhileDraining.pipe(Effect.andThen(work), Effect.map(Option.some))
                    : Effect.succeed(Option.none<A>()),
                ),
              ),
            ),
            ownerScope,
            { uninterruptible: false },
          );
          const outcome = yield* restore(Fiber.join(worker)).pipe(
            Effect.onInterrupt(() =>
              settle("withdrawn").pipe(
                Effect.flatMap((withdrawn) => (withdrawn ? Fiber.interrupt(worker) : Effect.void)),
              ),
            ),
          );
          return Option.isSome(outcome) ? outcome.value : yield* Effect.interrupt;
        }),
      );
    });

  const readSaved = options.state.read(stackId).pipe(
    Effect.flatMap((saved) =>
      saved === undefined
        ? Effect.fail(
            new StackNamespace.NamespaceError({
              operation: "read",
              message: "Saved stack is missing",
            }),
          )
        : Effect.succeed(saved),
    ),
  );
  const updateState = (update: (current: SavedStack) => SavedStack) =>
    options.state.withLock(
      readSaved.pipe(Effect.flatMap((current) => options.state.save(update(current)))),
    );
  // Idempotent on an already-missing registration: the registration, or the whole state root
  // with its registry lock, may vanish under destroy, so a failure counts only while it remains.
  const removeInstanceRegistration = (id: string) =>
    options.state
      .withLock(
        options.state
          .read(stackId)
          .pipe(
            Effect.flatMap((current) =>
              current === undefined
                ? Effect.void
                : options.state.save(withoutInstance(current, id)),
            ),
          ),
      )
      .pipe(
        Effect.catch((error) =>
          options.state
            .read(stackId)
            .pipe(
              Effect.flatMap((registered) =>
                registered === undefined ? Effect.void : Effect.fail(error),
              ),
            ),
        ),
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
        const previous = current.credentials;
        if (previous === undefined) {
          yield* options.state.save({ ...current, credentials: next });
          return next;
        }
        const consumers = current.instances.filter(({ creation }) => consumesCredentials(creation));
        const refreshed = new Map(
          yield* Effect.forEach(consumers, ({ id, creation }) =>
            refreshCredentials(creation, previous, next).pipe(
              Effect.map((refreshedCreation) => [id, refreshedCreation] as const),
            ),
          ),
        );
        yield* orchestrator.whileStopped(
          new Set([
            ...current.composition.members.map(({ id }) => id),
            ...current.composition.dependencies.flatMap(({ from, to }) => [from, to]),
            ...consumers.map(({ id }) => id),
          ]),
          (id) =>
            new CredentialError({
              message: `Service ${id} must be stopped with wake disabled before stack credentials change`,
            }),
          Effect.gen(function* () {
            yield* options.state.save({
              ...current,
              credentials: next,
              instances: current.instances.map((instance) => {
                const creation = refreshed.get(instance.id);
                return creation === undefined ? instance : { ...instance, creation };
              }),
            });
            yield* Effect.forEach(
              refreshed,
              ([id, creation]) =>
                orchestrator
                  .get(id)
                  .pipe(Effect.flatMap((entry) => Ref.set(entry.creation, creation))),
              { discard: true },
            );
          }),
        );
        yield* Effect.annotateCurrentSpan("refreshed_instances", refreshed.size);
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
      project,
      root: options.root,
      cacheRoot: options.cacheRoot,
      runtime,
      helpers,
      ...(options.hostGateway === undefined ? {} : { hostGateway: options.hostGateway }),
      ...(options.engineTarget === undefined ? {} : { engineTarget: options.engineTarget }),
    }).pipe(Effect.provideContext(services));

  const sameCreation = Schema.toEquivalence(ServiceCreation);
  const persistCreation = (entry: Pick<Entry, "id" | "creation">, creation: ServiceCreation) =>
    Ref.get(entry.creation).pipe(
      Effect.flatMap((saved) =>
        sameCreation(saved, creation)
          ? Effect.void
          : updateState((current) => ({
              ...current,
              instances: current.instances.map((instance) =>
                instance.id === entry.id ? { ...instance, creation } : instance,
              ),
            })).pipe(Effect.andThen(Ref.set(entry.creation, creation))),
      ),
    );

  const register = Effect.fn("Owner.register")(function* (id: string, recipe: CatalogRecipe) {
    if (Option.isSome(yield* orchestrator.get(id).pipe(Effect.option)))
      return yield* new Orchestrator.OrchestratorError({
        operation: "register",
        message: `Duplicate instance ${id}`,
      });
    const initial = recipe.creation;
    const resumeAfter = Option.getOrUndefined(
      yield* logStore.latestLaunchId({ service: initial.service, instanceId: id }),
    );
    const launches = yield* SubscriptionRef.make<number | undefined>(undefined);
    const creation = yield* Ref.make(initial);
    const core = yield* makeService(
      {
        ...recipe.definition,
        launch: (context) =>
          SubscriptionRef.set(launches, context.launchId).pipe(
            Effect.andThen(
              Scope.addFinalizer(context.scope, SubscriptionRef.set(launches, undefined)),
            ),
            Effect.andThen(persistCreation({ id, creation }, context.config)),
            Effect.mapError(serviceError("state")),
            Effect.andThen(recipe.definition.launch(context)),
          ),
      },
      {
        id,
        config: initial,
        report: orchestrator.report,
        ...(resumeAfter === undefined ? {} : { lastLaunchId: resumeAfter }),
      },
    ).pipe(Effect.provideService(Scope.Scope, ownerScope));
    // Listeners stay open while the service runs or demand can still wake it.
    const enabled = orchestrator.status(id).pipe(
      Effect.map((status) => !Orchestrator.isStoppedAndWakeDisabled(status)),
      Effect.orElseSucceed(() => false),
    );
    const configFor = (inputs: Record<string, string>, candidate: unknown) =>
      Ref.get(creation).pipe(
        Effect.flatMap((current) => restartCreation(current, candidate)),
        Effect.flatMap((next) => mergeInputs(next, inputs)),
        Effect.flatMap(requireInputs),
      );
    const endpoints = Object.fromEntries(
      endpointNames(initial).map((name) => {
        const shared = sharedRoutes(initial, name, routeKeys);
        const join = joinRoutes(initial, name);
        const endpoint: NetworkEndpoint = {
          protocol: name === "http" ? "http" : "tcp",
          port: endpointPort(initial, name),
          backend: orchestrator
            .acquire(id, name !== "inspector", `traffic on endpoint ${name}`)
            .pipe(
              Effect.andThen(recipe.endpoint(name)),
              Effect.map(backendAddress),
              Effect.mapError((cause) =>
                cause instanceof ProxyError
                  ? cause
                  : new ProxyError({ message: cause.message, cause }),
              ),
            ),
          enabled,
          ...(shared === undefined ? {} : { shared }),
          ...(join === undefined ? {} : { join }),
        };
        return [name, endpoint];
      }),
    );
    const namespace = yield* network.register({ id, endpoints });
    const entry: Entry = {
      id,
      service: initial.service,
      core,
      recipe,
      creation,
      namespace,
      confirmRemoved: removeInstanceRegistration(id).pipe(
        Effect.mapError(serviceError("state")),
        // Shipping writes its cursor into the instance's logs, so it stops before they go.
        Effect.andThen(forwarder.detach(id)),
        Effect.andThen(
          logStore
            .remove({ service: initial.service, instanceId: id })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  `${cause.message}; the next owner start or stack destroy retries`,
                  cause,
                ),
              ),
            ),
        ),
      ),
      release: namespace.release.pipe(Effect.mapError(serviceError("release"))),
      releasePorts: namespace.releasePorts.pipe(Effect.mapError(serviceError("release"))),
      launch: (generation, inputs, candidate) =>
        configFor(inputs, candidate).pipe(
          Effect.flatMap((config) => core.launch(generation, config)),
        ),
      prepare: (inputs, candidate) =>
        configFor(inputs, candidate).pipe(Effect.flatMap((config) => core.prepare(config))),
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
    yield* logStore.attach({
      service: initial.service,
      instanceId: id,
      logs: recipe.logs,
      launches: SubscriptionRef.changes(launches),
    });
    yield* forwarder.attach({
      id,
      service: initial.service,
      endpoint: recipe.endpoint,
      creation: Ref.get(creation),
      serving: orchestrator.changes(id).pipe(
        Stream.mapEffect((status) =>
          SubscriptionRef.get(launches).pipe(
            Effect.map((launchId) => ({
              serving: status.lifecycle === "running" && status.health === "healthy",
              launchId,
            })),
          ),
        ),
        Stream.catch(() => Stream.empty),
      ),
    });
  });

  for (const saved of options.saved.instances)
    yield* register(saved.id, yield* recipeFor(saved.creation, saved.id));
  yield* logStore.removeOrphans.pipe(
    Effect.catch((cause) => Effect.logWarning("Orphaned instance logs were not removed", cause)),
  );
  yield* orchestrator.configure(options.saved.composition);
  yield* forwarder.rebind;

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
    | ServiceError
    | Network.NetworkError;

  const configure = (configuration: CompositionConfig) =>
    options.state.withLock(
      orchestrator
        .configure(
          configuration,
          readSaved.pipe(
            Effect.flatMap((current) =>
              options.state.save({ ...current, composition: configuration }),
            ),
          ),
        )
        .pipe(Effect.andThen(forwarder.rebind)),
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
          status: orchestrator.status,
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

  const observe = (entry: Entry, value: Orchestrator.Status) =>
    Effect.all({ config: Ref.get(entry.creation), endpoints: entry.namespace.bindings }).pipe(
      Effect.map((current) => ({ ...value, ...current })),
    );
  const observation = (id: string) =>
    Effect.all([orchestrator.get(id), orchestrator.status(id)]).pipe(
      Effect.flatMap(([entry, value]) => observe(entry, value)),
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
    return yield* orchestrator.storage(
      id,
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
    readyService: ({ id }) => orchestrator.ready(id).pipe(rpcError("readyService")),
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
              orchestrator.changes(id).pipe(Stream.mapEffect((value) => observe(entry, value))),
            ),
          ),
      ).pipe(Stream.mapError((cause) => stackError("followStatus", cause))),
    readLogs: ({ id, from, since, tail, follow }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          return yield* logStore.read(id, {
            from: from ?? "oldest",
            follow,
            ...(since === undefined ? {} : { since: yield* LogStore.sinceMillis(since) }),
            ...(tail === undefined ? {} : { tail }),
          });
        }),
      ).pipe(Stream.mapError((cause) => stackError("readLogs", cause))),
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

  const sweep = sweepContainers(options.saved, options.root, options.engineTarget).pipe(
    Effect.provideContext(services),
  );
  const getStackCredentials = readSaved.pipe(
    Effect.flatMap(({ credentials }) =>
      credentials === undefined
        ? Effect.fail(
            new CredentialError({ message: "Stack credentials have not been established" }),
          )
        : Effect.succeed(credentials),
    ),
    Effect.withSpan("Owner.getStackCredentials"),
  );

  return {
    handlers,
    getStackCredentials,
    namespace: {
      // Services stop in reverse dependency order with their listeners open, so a dependent's
      // graceful stop can still reach its prerequisites through the proxy.
      stop: orchestrator.stopNamespace.pipe(
        Effect.andThen(sweep),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.stopNamespace"),
      ),
      // Instance teardown retains port rows until the registration is gone; the release after
      // that is best-effort because `isGone` reclaims a gone stack's rows lazily.
      destroy: confirmStackDataRoot(options.state.root, stackId).pipe(
        Effect.provideContext(services),
        Effect.andThen(orchestrator.destroyNamespace),
        Effect.andThen(sweep),
        Effect.andThen(removeDataRootEntries),
        Effect.andThen(logStore.close),
        Effect.andThen(options.state.remove(stackId)),
        Effect.andThen(
          network.releaseStack.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Destroyed stack could not release its port reservations", cause),
            ),
          ),
        ),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.destroyNamespace"),
      ),
      release: orchestrator.stopNamespace.pipe(
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.releaseNamespace"),
      ),
    },
  } satisfies Interface;
});

export const layer = (options: Omit<OwnerOptions, "state">) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* StackNamespace.Service;
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

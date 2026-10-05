import {
  Cause,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
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
import type { PlatformError } from "effect/PlatformError";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { failureMessage } from "./internal/failure-message.ts";
import * as Network from "./Network.ts";
import type { NetworkEndpoint, NetworkNamespace } from "./Network.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import { PortError } from "./Ports.ts";
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
import * as Claims from "./namespace/Claims.ts";
import { namespaceError } from "./namespace/Capabilities.ts";
import { lstatPath } from "./namespace/drivers/FileSystem.ts";
import * as Paths from "./namespace/Paths.ts";
import { resolveNativeRuntimeRootForRecovery } from "./runtime/postgres-user.ts";
import { projectSegmentFor } from "./identity/Identity.ts";
import { stackError, type OwnerRpc } from "./Rpc.ts";
import * as StackNamespace from "./StackNamespace.ts";
import type { SavedStack, StackCredentials, StackKeysInput } from "./StackNamespace.ts";
import { makeDockerHelperRegistry } from "./storage/DockerHelperRegistry.ts";

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

/** True when `target` exists in any form (a real entry or a symlink); lstat-style, never follows. */
const directoryClaimExists = Effect.fn("Owner.directoryClaimExists")(function* (target: string) {
  return (yield* lstatPath(target)) !== undefined;
});

/**
 * Reconciles this stack's directory claims by exact identity, then removes every container
 * carrying this stack's identity and data-root labels through the owner's pinned engine target.
 * A directory claim outside every owned root is kept and reported, so recovery (possibly as root)
 * never deletes what it does not own; one naming a path that no longer exists in any form is
 * simply dropped, nothing left to remove. A container that survives removal fails the sweep, so
 * the caller (startup, stop, or destroy) can report it and retry instead of proceeding as if the
 * stack were fully torn down.
 */
export const sweepContainers = Effect.fn("Owner.sweepContainers")(function* (
  state: StackNamespace.Interface,
  saved: Pick<SavedStack, "id" | "runtime">,
  root: string,
  target: Container.EngineTarget | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Missing, foreign, or symlinked is "no such owned root", not a sweep failure: anything claimed
  // under it is reported, not deleted through whatever replaced it.
  const nativeRuntimeRoot = yield* resolveNativeRuntimeRootForRecovery().pipe(Effect.option);
  const ownedRoots = [root, ...Option.toArray(nativeRuntimeRoot)];
  yield* Claims.reconcile(
    state,
    saved.id,
    (claim): Effect.Effect<"removed" | "kept", PlatformError | StackNamespace.NamespaceError> =>
      directoryClaimExists(claim.id).pipe(
        Effect.flatMap((present) =>
          !present
            ? Effect.succeed("removed" as const)
            : Paths.isWithinOwnedRoots(fs, path, claim.id, ownedRoots, (_operation, cause) =>
                namespaceError("cleanup", cause),
              ).pipe(
                Effect.flatMap((within) =>
                  within
                    ? fs
                        .remove(claim.id, { recursive: true, force: true })
                        .pipe(Effect.as("removed" as const))
                    : Effect.logWarning(
                        `Claimed directory ${claim.id} resolves outside every owned root; keeping it`,
                      ).pipe(Effect.as("kept" as const)),
                ),
              ),
        ),
      ),
  );
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
     * containers, claims and saved state.
     */
    readonly destroy: Effect.Effect<void, NamespaceError>;
    /**
     * Ends ownership after a confirmed-gone registration: drains, stops every workload, and
     * removes what it created through the same registration-independent cleanup path as destroy,
     * without touching the registration or releasing port reservations. A leftover resource past
     * the engine-unreachable backstop is logged, not thrown.
     */
    readonly abandon: Effect.Effect<void>;
  };
  /** Direct probe of the pinned engine target; always `true` for a native stack. */
  readonly engineAvailable: Effect.Effect<boolean>;
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

/**
 * The first backoff delay {@link retryUntilConfirmed} sleeps between attempts, doubling up to 5
 * seconds. Internal only: a test overrides this reference to observe several attempts without
 * waiting through a production-length backoff, never through an env var or `Config`.
 */
export const RetryUntilConfirmedInitialDelay = Context.Reference<Duration.Input>(
  "@supabase/stack/RetryUntilConfirmedInitialDelay",
  { defaultValue: () => Duration.millis(200) },
);

/**
 * Retries `operation` with a bounded, doubling backoff until it succeeds or `engineAvailable`
 * resolves `false`: engine availability is a direct probe, never a message or cause
 * classification, so this is the one place every abandonment cleanup stage decides whether a
 * failure is worth retrying. A `false` probe fails with the operation's own last error; an
 * interruption or defect is never retried.
 */
export const retryUntilConfirmed = <A, E>(
  operation: Effect.Effect<A, E>,
  engineAvailable: Effect.Effect<boolean>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    let delay = Duration.fromInputUnsafe(yield* RetryUntilConfirmedInitialDelay);
    while (true) {
      const result = yield* Effect.exit(operation);
      if (Exit.isSuccess(result)) return result.value;
      const failure = Cause.findErrorOption(result.cause);
      if (Option.isNone(failure)) return yield* Effect.failCause(result.cause);
      if (!(yield* engineAvailable)) return yield* Effect.fail(failure.value);
      yield* Effect.sleep(delay);
      delay = Duration.min(Duration.times(delay, 2), Duration.seconds(5));
    }
  });

/**
 * Cleans up one abandoned instance through the same confirmed, serialized execution path destroy
 * uses (`core.removeData`, under the service's execution lock, retrying only steps a previous
 * attempt didn't finish), but without a `confirm` step: abandonment never touches the registration.
 * Retries transient failures; only a confirmed-unreachable engine is logged and left behind, so a
 * recoverable failure never blocks the owner's exit.
 */
const cleanupAbandonedInstance = (entry: Entry, engineAvailable: Effect.Effect<boolean>) =>
  retryUntilConfirmed(entry.core.removeData(), engineAvailable).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Abandoned stack could not confirm cleanup of ${entry.service} ${entry.id}; leaving it behind`,
        error,
      ),
    ),
  );

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
  const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
  const network = yield* Network.Service;
  const portReservations = yield* PortReservations.Service;
  // A native stack has no engine to lose, so every cleanup failure is retried forever; a docker
  // stack probes the pinned target directly, never by classifying a failure's cause.
  const engineAvailable: Effect.Effect<boolean> =
    options.engineTarget === undefined
      ? Effect.succeed(true)
      : Container.probeEngineReachable(spawner, options.engineTarget);
  // Shared per-launch environment-file scratch directory (Container.ts), owned by this stack as a
  // whole rather than any one instance; registration-independent so destroy and abandonment both
  // reach it without depending on `Registry.remove`, which never runs during abandonment.
  const removeContainerEnvRoot = fs
    .remove(path.join(options.root, Paths.CONTAINER_ENV_DIRNAME), { recursive: true, force: true })
    .pipe(Effect.mapError(serviceError("cleanup")));
  const isPubliclyReserved = (port: number) =>
    portReservations.isReserved(port).pipe(
      Effect.mapError(
        (cause) =>
          new PortError({
            key: "native",
            message: "Unable to check the public port reservation registry",
            cause,
          }),
      ),
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
  // Idempotent on an already-missing registration (a deleted or already-destroyed state.json),
  // unlike `updateState`: destroy must still be able to publish an instance's removal, or confirm
  // there is nothing left to publish, even when the registration disappeared from under it.
  const removeInstanceRegistration = (id: string) =>
    options.state.withLock(
      options.state
        .read(stackId)
        .pipe(
          Effect.flatMap((current) =>
            current === undefined ? Effect.void : options.state.save(withoutInstance(current, id)),
          ),
        ),
    );

  const requireStopped = (configuration: CompositionConfig) =>
    Effect.forEach(
      new Set([
        ...configuration.members.map(({ id }) => id),
        ...configuration.dependencies.flatMap(({ from, to }) => [from, to]),
      ]),
      (id) =>
        orchestrator.status(id).pipe(
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

  const claims = Claims.forStack(options.state, stackId);
  const recipeFor = (creation: ServiceCreation, id: string) =>
    makeServiceRecipe(creation, {
      stackId,
      instanceId: id,
      project,
      root: options.root,
      cacheRoot: options.cacheRoot,
      runtime,
      helpers,
      directoryClaims: claims.directories,
      isPubliclyReserved,
      ...(options.hostGateway === undefined ? {} : { hostGateway: options.hostGateway }),
      ...(options.engineTarget === undefined ? {} : { engineTarget: options.engineTarget }),
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
    const core = yield* makeService(
      {
        ...recipe.definition,
        launch: (context) =>
          persistCreation({ id, creation }, context.config).pipe(
            Effect.mapError(serviceError("state")),
            Effect.andThen(recipe.definition.launch(context)),
          ),
      },
      { id, config: initial, report: orchestrator.report },
    ).pipe(Effect.provideService(Scope.Scope, ownerScope));
    // Listeners stay open while the service runs or demand can still wake it.
    const enabled = orchestrator.status(id).pipe(
      Effect.map(
        (status) => status.registered && (status.wakeEnabled || status.lifecycle !== "stopped"),
      ),
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
      confirmRemoved: removeInstanceRegistration(id).pipe(Effect.mapError(serviceError("state"))),
      release: namespace.release.pipe(Effect.mapError(serviceError("release"))),
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
    | ServiceError
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

  const sweep = sweepContainers(
    options.state,
    options.saved,
    options.root,
    options.engineTarget,
  ).pipe(Effect.provideContext(services));
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
      // Shutdown drain: accept closes on every listener before any service stops, and the
      // listener scopes only close afterward, through stop/destroy's ordinary teardown below.
      stop: network.drain.pipe(
        Effect.andThen(orchestrator.stopNamespace),
        Effect.andThen(sweep),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.stopNamespace"),
      ),
      destroy: network.beginDestroy.pipe(
        // Deferred for the whole of this destroy: every instance's own teardown below closes its
        // listeners as usual, but leaves its reservation rows for `releaseStack` to drop together,
        // only once destroy is confirmed to leave nothing behind. `ensuring` below resumes
        // immediate per-service deletion again on every exit, success, failure, or interruption
        // alike, so a service destruction, sweep, or claim-read failure can never leave deferral
        // stuck on for a stack that is still otherwise live.
        Effect.andThen(network.drain),
        Effect.andThen(orchestrator.destroyNamespace),
        Effect.andThen(sweep),
        // A directory claim deliberately kept (for example one resolving outside every owned
        // root) must not be lost to a full deregistration; the stack stays registered so a later
        // acquisition's reconcile can still finish it.
        Effect.andThen(options.state.readClaims(stackId)),
        Effect.flatMap((remaining) =>
          remaining.length === 0
            ? removeContainerEnvRoot.pipe(
                Effect.andThen(network.releaseStack),
                Effect.andThen(options.state.remove(stackId)),
              )
            : Effect.gen(function* () {
                const claimsPath = path.join(options.state.root, stackId, Claims.CLAIMS_FILE);
                const listed = remaining.map((claim) => `  - ${claim.kind} ${claim.id}`).join("\n");
                return yield* new StackNamespace.NamespaceError({
                  operation: "destroy",
                  message: [
                    `${remaining.length} resource claim(s) could not be reconciled; stack stays registered for retry.`,
                    listed,
                    `To recover: confirm the listed directories are safe to remove, then run \`supabase stack destroy\` again. ` +
                      `If they are not, remove the listed claim entries from ${claimsPath} and retry.`,
                  ].join("\n"),
                });
              }),
        ),
        Effect.ensuring(network.cancelDestroy),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.destroyNamespace"),
      ),
      // Settles admitted definition work under the same gate as stop/destroy first. Never
      // reads or writes the registration (already confirmed gone), so every step below is
      // best-effort and logs rather than fails; the caller must still be able to exit.
      abandon: network.drain.pipe(
        Effect.andThen(
          orchestrator.stopNamespace.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Abandoned stack could not confirm every workload stopped", cause),
            ),
          ),
        ),
        Effect.andThen(
          orchestrator.instances.pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(entries, (entry) => cleanupAbandonedInstance(entry, engineAvailable), {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
          ),
        ),
        // Registration-independent confirming sweep: every container carrying this stack's
        // identity and data-root labels, found through the pinned engine directly rather than
        // through any in-memory helper registry's own bookkeeping — covers a shared storage
        // helper the per-instance cleanup above never removes on its own. The data-root label
        // keeps this scoped to this owner's own containers even when another owner shares the
        // same stack id under a different root.
        Effect.andThen(
          options.engineTarget === undefined
            ? Effect.void
            : retryUntilConfirmed(
                Container.removeStackContainers({
                  target: options.engineTarget,
                  stackId,
                  stackRoot: path.resolve(options.root),
                }).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError(serviceError("cleanup")),
                  Effect.filterOrFail(
                    (remaining) => remaining.length === 0,
                    (remaining) =>
                      new ServiceError({
                        operation: "cleanup",
                        message: `Containers remain: ${remaining.join(", ")}`,
                      }),
                  ),
                ),
                engineAvailable,
              ).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning(
                    "Abandoned stack could not confirm every container removed; leaving it behind",
                    cause,
                  ),
                ),
              ),
        ),
        // Filesystem-only, so always retried to confirmation regardless of engine availability:
        // its own `force: true` tolerates an already-gone directory, never a transient failure.
        // Port reservations are never released here: a stale reservation stays for `Ports.ts`'s
        // own lazy reclamation once the holder's registration is confirmed gone, the abandonment
        // trigger, so abandonment never touches `Ports.ts`'s registry at all.
        Effect.andThen(
          retryUntilConfirmed(removeContainerEnvRoot, Effect.succeed(true)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Abandoned stack could not remove its container-env root", cause),
            ),
          ),
        ),
        definitionGate.withPermits(1),
        Effect.withSpan("Owner.abandonNamespace", { attributes: { stack_id: stackId } }),
      ),
    },
    engineAvailable,
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
    Layer.provide(PortReservations.layer),
  );

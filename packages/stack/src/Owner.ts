import {
  Context,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Ref,
  Scope,
  Schema,
  Semaphore,
  Stream,
  Layer,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Network from "./Network.ts";
import type { NetworkBinding, NetworkNamespace } from "./Network.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { CompositionConfig, RegisteredInstance } from "./Orchestrator.ts";
import {
  makeService,
  ServiceError,
  ServiceLaunchError,
  type ServiceInstance,
  type ServiceObservation,
} from "./Service.ts";
import { ProxyError, type BackendAddress } from "./Proxy.ts";
import type { NetworkEndpoint } from "./Network.ts";
import {
  apiRoute,
  credentialsFor,
  endpointNames,
  endpointPort,
  EndpointError,
  outputsFor,
  publicUrl,
} from "./host/Endpoints.ts";
import { makeSupabaseComposition } from "./composition/Supabase.ts";
import { SupabaseCompositionError } from "./composition/Supabase.ts";
import {
  makeServiceRecipe,
  ServiceCreation,
  type CatalogLog,
  type CatalogRecipe,
  serviceSchemas,
} from "./services/Catalog.ts";
import { makeDatabaseSnapshots, type DatabaseSnapshot } from "./services/DatabaseSnapshot.ts";
import * as State from "./State.ts";
import type { SavedInstance, SavedStack } from "./State.ts";

export class OwnerError extends Data.TaggedError("OwnerError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface OwnerOptions {
  readonly saved: SavedStack;
  readonly state: State.Interface;
  readonly root: string;
  readonly cacheRoot: string;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/Owner") {}

type OwnerObservation = ServiceObservation<ServiceCreation> & {
  readonly endpoints: ReadonlyArray<NetworkBinding>;
};

export interface Interface {
  readonly services: {
    readonly create: (
      creation: unknown,
    ) => Effect.Effect<{ id: string; creation: ServiceCreation }, OwnerError>;
    readonly get: (
      id: string,
    ) => Effect.Effect<{ id: string; creation: ServiceCreation }, OwnerError>;
    readonly list: Effect.Effect<
      ReadonlyArray<{ id: string; creation: ServiceCreation }>,
      OwnerError
    >;
  };
  readonly core: {
    readonly get: (id: string) => Effect.Effect<OwnerObservation, OwnerError>;
    readonly status: (id: string) => Effect.Effect<OwnerObservation, OwnerError>;
    readonly followStatus: (id: string) => Stream.Stream<OwnerObservation, OwnerError>;
    readonly prepare: (id: string) => Effect.Effect<void, OwnerError>;
    readonly logs: (id: string) => Stream.Stream<CatalogLog, OwnerError>;
    readonly start: (id: string) => Effect.Effect<void, OwnerError>;
    readonly ready: (id: string) => Effect.Effect<void, OwnerError>;
    readonly stop: (id: string) => Effect.Effect<void, OwnerError>;
    readonly restart: (id: string, creation?: unknown) => Effect.Effect<void, OwnerError>;
    readonly destroy: (id: string) => Effect.Effect<void, OwnerError>;
  };
  readonly composition: {
    readonly supabase: (
      creations: ReadonlyArray<ServiceCreation>,
    ) => Effect.Effect<ReadonlyArray<{ id: string; creation: ServiceCreation }>, OwnerError>;
    readonly configure: (configuration: CompositionConfig) => Effect.Effect<void, OwnerError>;
    readonly get: Effect.Effect<CompositionConfig, OwnerError>;
    readonly start: Effect.Effect<ReadonlyArray<OwnerObservation>, OwnerError>;
    readonly stop: Effect.Effect<ReadonlyArray<OwnerObservation>, OwnerError>;
    readonly restart: Effect.Effect<ReadonlyArray<OwnerObservation>, OwnerError>;
  };
  readonly credentials: (
    id: string,
    from: "host" | "runtime",
  ) => Effect.Effect<Readonly<Record<string, string>>, OwnerError>;
  readonly snapshots: {
    readonly exportSnapshot: (
      id: string,
      destination: string,
    ) => Effect.Effect<DatabaseSnapshot, OwnerError>;
    readonly restoreSnapshot: (
      id: string,
      source: string,
    ) => Effect.Effect<DatabaseSnapshot, OwnerError>;
  };
  readonly namespace: {
    readonly stop: Effect.Effect<void, OwnerError>;
    readonly destroy: Effect.Effect<void, OwnerError>;
  };
  readonly setDraining: (draining: boolean) => Effect.Effect<void, OwnerError>;
  readonly getServing: Effect.Effect<boolean, OwnerError>;
}

const errorFor = (operation: string, cause: unknown) =>
  new OwnerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const supabaseError = (cause: unknown) =>
  cause instanceof SupabaseCompositionError
    ? cause
    : new SupabaseCompositionError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const creationJson = Schema.toCodecJson(ServiceCreation);
const encodeCreation = (creation: ServiceCreation) => Schema.encodeEffect(creationJson)(creation);

const makeOwnerWithDependencies = (
  options: OwnerOptions,
  orchestrator: Orchestrator.Interface,
  network: Network.Interface,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    const ownerScope = yield* Scope.Scope;
    const recipes = yield* Ref.make(new Map<string, CatalogRecipe>());
    const instances = yield* Ref.make(new Map<string, ServiceInstance<ServiceCreation>>());
    const namespaces = yield* Ref.make(new Map<string, NetworkNamespace>());
    const composition = yield* Ref.make<CompositionConfig>({ members: [], dependencies: [] });
    const registryGate = yield* Semaphore.make(1);
    const compositionGate = yield* Semaphore.make(1);
    const draining = yield* Ref.make(false);
    const runtime = options.saved.runtime;

    const updateState = Effect.fn("Owner.updateState")(function* (
      update: (current: SavedStack) => Effect.Effect<SavedStack, OwnerError>,
    ) {
      return yield* options.state
        .withLock(
          Effect.gen(function* () {
            const current = yield* options.state
              .read(options.saved.id)
              .pipe(Effect.mapError((cause) => errorFor("state", cause)));
            if (current === undefined) return yield* errorFor("state", "Saved stack is missing");
            const next = yield* update(current);
            yield* options.state
              .save(next)
              .pipe(Effect.mapError((cause) => errorFor("state", cause)));
            return next;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof OwnerError ? cause : errorFor("state", cause),
          ),
        );
    });

    const persistCreation = Effect.fn("Owner.persistCreation")(function* (
      id: string,
      creation: ServiceCreation,
    ) {
      const encoded = yield* encodeCreation(creation).pipe(
        Effect.mapError((cause) => errorFor("state", cause)),
      );
      yield* updateState((current) =>
        Effect.succeed({
          ...current,
          instances: current.instances.map((instance) =>
            instance.id === id ? { ...instance, creation: encoded } : instance,
          ),
        }),
      );
      yield* Ref.update(recipes, (values) => {
        const recipe = values.get(id);
        if (recipe === undefined) return values;
        return new Map(values).set(id, { ...recipe, creation });
      });
    });

    const addCreation = Effect.fn("Owner.addCreation")(function* (
      id: string,
      creation: ServiceCreation,
    ) {
      const encoded = yield* encodeCreation(creation).pipe(
        Effect.mapError((cause) => errorFor("state", cause)),
      );
      yield* updateState((current) =>
        Effect.succeed({
          ...current,
          instances: [...current.instances, { id, creation: encoded } satisfies SavedInstance],
        }),
      );
    });

    const removeCreation = (id: string) =>
      updateState((current) =>
        Effect.succeed({
          ...current,
          instances: current.instances.filter((instance) => instance.id !== id),
        }),
      ).pipe(Effect.asVoid);

    const persistComposition = (value: CompositionConfig) =>
      updateState((current) => Effect.succeed({ ...current, composition: value })).pipe(
        Effect.asVoid,
      );
    const removeFromComposition = (id: string) =>
      Ref.get(composition).pipe(
        Effect.map((current) => ({
          members: current.members.filter((member) => member.id !== id),
          dependencies: current.dependencies.filter(
            (dependency) => dependency.from !== id && dependency.to !== id,
          ),
        })),
        Effect.tap((next) => Ref.set(composition, next)),
        Effect.tap(persistComposition),
        Effect.asVoid,
      );

    const recipeFor = (input: unknown, id: string) =>
      makeServiceRecipe(input, {
        stackId: options.saved.id,
        instanceId: id,
        root: options.root,
        cacheRoot: options.cacheRoot,
        runtime,
      }).pipe(Effect.mapError((cause) => errorFor("recipe", cause)));
    const recipeReady = (input: unknown, id: string) =>
      recipeFor(input, id).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(Scope.Scope, ownerScope),
      );

    const getRecipe = (id: string) =>
      Ref.get(recipes).pipe(
        Effect.flatMap((values) => {
          const recipe = values.get(id);
          return recipe === undefined
            ? Effect.fail(errorFor("get", `Unknown service ${id}`))
            : Effect.succeed(recipe);
        }),
      );

    const getCreation = (id: string) => getRecipe(id).pipe(Effect.map((recipe) => recipe.creation));

    const mergeInputs = (creation: ServiceCreation, inputs: Record<string, string>) =>
      Schema.decodeUnknownEffect(ServiceCreation)({
        ...creation,
        config: { ...creation.config, ...inputs },
      }).pipe(
        Effect.mapError(
          (cause) => new ServiceError({ operation: "inputs", message: String(cause) }),
        ),
      );

    const restartCreation = (
      creation: ServiceCreation,
      candidate: unknown,
    ): Effect.Effect<ServiceCreation, ServiceError> => {
      if (candidate === undefined) return Effect.succeed(creation);
      const config = isRecord(candidate) && "config" in candidate ? candidate.config : candidate;
      return Schema.decodeUnknownEffect(ServiceCreation)({
        ...creation,
        config,
      }).pipe(
        Effect.mapError(
          (cause) => new ServiceError({ operation: "restart", message: String(cause) }),
        ),
      );
    };

    const register = Effect.fn("Owner.register")(function* (id: string, recipe: CatalogRecipe) {
      const initial = recipe.creation;
      const namespaceRef = yield* Ref.make<NetworkNamespace | undefined>(undefined);
      const instance = yield* makeService(
        {
          ...recipe.definition,
          launch: (context) =>
            persistCreation(id, context.config).pipe(
              Effect.mapError(
                (cause) => new ServiceError({ operation: "state", message: cause.message, cause }),
              ),
              Effect.andThen(recipe.definition.launch(context)),
              Effect.map((session) => ({
                ...session,
                remove: session.remove.pipe(
                  Effect.andThen(
                    Ref.get(namespaceRef).pipe(
                      Effect.flatMap((value) => value?.close ?? Effect.void),
                      Effect.mapError(
                        (cause) =>
                          new ServiceError({ operation: "close", message: cause.message, cause }),
                      ),
                    ),
                  ),
                ),
              })),
              Effect.catchTag("ServiceLaunchError", (failure) =>
                Effect.fail(
                  new ServiceLaunchError({
                    failure: failure.failure,
                    runtime: {
                      ...failure.runtime,
                      remove: failure.runtime.remove.pipe(
                        Effect.andThen(
                          Ref.get(namespaceRef).pipe(
                            Effect.flatMap((value) => value?.close ?? Effect.void),
                            Effect.mapError(
                              (cause) =>
                                new ServiceError({
                                  operation: "close",
                                  message: cause.message,
                                  cause,
                                }),
                            ),
                          ),
                        ),
                      ),
                    },
                  }),
                ),
              ),
            ),
          removeData: (context) =>
            recipe.definition.removeData(context).pipe(
              Effect.andThen(
                Ref.get(namespaceRef).pipe(
                  Effect.flatMap((value) => value?.release ?? Effect.void),
                  Effect.mapError(
                    (cause) =>
                      new ServiceError({ operation: "release", message: cause.message, cause }),
                  ),
                ),
              ),
              Effect.andThen(
                removeCreation(id).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServiceError({ operation: "state", message: cause.message, cause }),
                  ),
                ),
              ),
              Effect.andThen(
                removeFromComposition(id).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServiceError({
                        operation: "composition",
                        message: cause.message,
                        cause,
                      }),
                  ),
                ),
              ),
            ),
        },
        {
          id,
          config: initial,
          coordinate: (operation, transition) =>
            Ref.get(draining).pipe(
              Effect.flatMap((isDraining) =>
                isDraining && ["start", "arm", "restart", "storage"].includes(operation)
                  ? Effect.fail(
                      new ServiceError({ operation: "draining", message: "Owner is draining" }),
                    )
                  : orchestrator.admissionFor(id)(operation, transition),
              ),
            ),
        },
      );
      const enabled = instance.get.pipe(
        Effect.map(
          (observation) =>
            observation.registered &&
            observation.lifecycle !== "stopped" &&
            !(observation.exit !== undefined && !observation.wakeEnabled),
        ),
      );
      const endpointEntries = Object.fromEntries(
        endpointNames(initial).map((name) => {
          const route = name === "http" ? apiRoute(initial.service) : undefined;
          const endpoint: NetworkEndpoint = {
            protocol: name === "http" ? ("http" as const) : ("tcp" as const),
            port: endpointPort(initial, name),
            backend: orchestrator.acquire(id, name !== "inspector").pipe(
              Effect.flatMap(() => recipe.endpoint(name)),
              Effect.flatMap((address): Effect.Effect<BackendAddress, ProxyError> => {
                if (address.kind === "unix") {
                  return address.path === undefined
                    ? Effect.fail(new ProxyError({ message: "Unix endpoint has no path" }))
                    : Effect.succeed({ path: `${address.path}/.s.PGSQL.${address.port}` });
                }
                return Effect.succeed({ host: address.host ?? "127.0.0.1", port: address.port });
              }),
              Effect.mapError((cause) =>
                cause instanceof ProxyError
                  ? cause
                  : new ProxyError({ message: String(cause), cause }),
              ),
            ),
            enabled,
            ...(route === undefined
              ? {}
              : {
                  shared:
                    initial.service === "realtime"
                      ? [
                          {
                            prefix: "/realtime/v1/api",
                            upstreamPrefix: "/api",
                            upstreamHost: "realtime-dev",
                          },
                          {
                            prefix: route,
                            upstreamPrefix: "/socket",
                            upstreamHost: "realtime-dev",
                          },
                        ]
                      : [{ prefix: route, upstreamPrefix: "/" }],
                }),
          };
          return [name, endpoint];
        }),
      );
      const namespace = yield* network
        .register({ id, endpoints: endpointEntries })
        .pipe(Effect.mapError((cause) => errorFor("network", cause)));
      yield* Ref.set(namespaceRef, namespace);
      const endpointAddress = (name: string, from: "host" | "runtime") =>
        namespace.address(name, from).pipe(
          Effect.mapError(
            (cause) =>
              new EndpointError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          ),
        );
      const databasePassword = () =>
        getCreation(id).pipe(
          Effect.flatMap((creation) =>
            creation.service === "database"
              ? Effect.succeed(Redacted.value(creation.config.databasePassword))
              : Effect.fail(new EndpointError({ message: "Output requires a database" })),
          ),
          Effect.mapError((cause) =>
            cause instanceof EndpointError
              ? cause
              : new EndpointError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
        );
      const outputs = Object.fromEntries(
        Object.entries(outputsFor(initial, endpointAddress, databasePassword)).map(
          ([name, value]) => [
            name,
            value.pipe(
              Effect.mapError(
                (cause) => new ServiceError({ operation: "output", message: cause.message, cause }),
              ),
            ),
          ],
        ),
      );
      const registered: RegisteredInstance = {
        id,
        core: {
          get: instance.get,
          ready: instance.ready,
          stop: instance.stop,
          destroy: instance.destroy,
          arm: instance.arm,
          armAt: instance.armAt,
          sleep: instance.sleep,
          observation: instance.observation,
        },
        startAt: (revision, inputs, wake, guard) =>
          getCreation(id).pipe(
            Effect.mapError(
              (cause) => new ServiceError({ operation: "get", message: cause.message, cause }),
            ),
            Effect.flatMap((creation) => mergeInputs(creation, inputs)),
            Effect.flatMap((candidate) => instance.startAt(revision, candidate, wake, guard)),
          ),
        restart: (revision, inputs, candidate, guard) =>
          getCreation(id).pipe(
            Effect.mapError(
              (cause) => new ServiceError({ operation: "get", message: cause.message, cause }),
            ),
            Effect.flatMap((creation) => restartCreation(creation, candidate)),
            Effect.flatMap((creation) => mergeInputs(creation, inputs)),
            Effect.flatMap((next) => instance.restart(next, revision, guard)),
          ),
        bind: namespace.bind.pipe(
          Effect.mapError(
            (cause) => new ServiceError({ operation: "bind", message: cause.message, cause }),
          ),
        ),
        close: namespace.close.pipe(
          Effect.mapError(
            (cause) => new ServiceError({ operation: "close", message: cause.message, cause }),
          ),
          Effect.tap(() =>
            instance.get.pipe(
              Effect.flatMap((observation) =>
                observation.registered
                  ? Effect.void
                  : Effect.all(
                      [
                        Ref.update(recipes, (values) => {
                          const next = new Map(values);
                          next.delete(id);
                          return next;
                        }),
                        Ref.update(instances, (values) => {
                          const next = new Map(values);
                          next.delete(id);
                          return next;
                        }),
                        Ref.update(namespaces, (values) => {
                          const next = new Map(values);
                          next.delete(id);
                          return next;
                        }),
                      ],
                      { discard: true },
                    ),
              ),
            ),
          ),
        ),
        hasEndpoint: endpointNames(initial).length > 0,
        inputs: Object.keys(serviceSchemas[initial.service].fields),
        outputs,
      };
      yield* registryGate.withPermits(1)(
        orchestrator.register(registered).pipe(
          Effect.catch((cause) => namespace.release.pipe(Effect.andThen(Effect.fail(cause)))),
          Effect.mapError(
            (cause) => new ServiceError({ operation: "register", message: String(cause), cause }),
          ),
        ),
      );
      yield* Ref.update(recipes, (values) => new Map(values).set(id, recipe));
      yield* Ref.update(instances, (values) => new Map(values).set(id, instance));
      yield* Ref.update(namespaces, (values) => new Map(values).set(id, namespace));
    });
    const registerReady = (id: string, recipe: CatalogRecipe) =>
      register(id, recipe).pipe(Effect.provideService(Scope.Scope, ownerScope));

    for (const saved of options.saved.instances) {
      const creation = yield* Schema.decodeUnknownEffect(creationJson)(saved.creation).pipe(
        Effect.mapError((cause) => errorFor("state", cause)),
      );
      yield* registerReady(saved.id, yield* recipeReady(creation, saved.id));
    }
    const savedComposition = yield* Schema.decodeUnknownEffect(Orchestrator.CompositionConfig)(
      options.saved.composition,
    ).pipe(Effect.mapError((cause) => errorFor("configure", cause)));
    yield* orchestrator
      .configure(savedComposition)
      .pipe(Effect.mapError((cause) => errorFor("configure", cause)));
    yield* Ref.set(composition, savedComposition);

    const get = Effect.fn("Owner.get")(function* (id: string) {
      return yield* getCreation(id).pipe(
        Effect.map((creation) => ({ id, creation })),
        Effect.mapError((cause) => errorFor("get", cause)),
      );
    });
    const enrichObservation = (id: string, value: ServiceObservation<unknown>) =>
      getCreation(id).pipe(
        Effect.mapError((cause) => errorFor("status", cause)),
        Effect.flatMap((creation) =>
          Ref.get(namespaces).pipe(
            Effect.mapError((cause) => errorFor("status", cause)),
            Effect.flatMap((values) => {
              const namespace = values.get(id);
              return namespace === undefined
                ? Effect.fail(errorFor("status", "Service namespace is missing"))
                : namespace.bindings.pipe(
                    Effect.map((endpoints) => ({ ...value, config: creation, endpoints })),
                    Effect.mapError((cause) => errorFor("status", cause)),
                  );
            }),
          ),
        ),
      );
    const observation = Effect.fn("Owner.status")(function* (id: string) {
      return yield* orchestrator.get(id).pipe(
        Effect.flatMap((instance) => instance.core.get),
        Effect.flatMap((value) => enrichObservation(id, value)),
        Effect.mapError((cause) =>
          cause instanceof OwnerError ? cause : errorFor("status", cause),
        ),
      );
    });
    const operation = <A, E>(
      name: string,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, OwnerError> =>
      effect.pipe(Effect.mapError((cause) => errorFor(name, cause)));
    const storage = <A>(
      id: string,
      action: Effect.Effect<A, OwnerError>,
    ): Effect.Effect<A, OwnerError> =>
      Ref.get(instances).pipe(
        Effect.flatMap((values) => {
          const instance = values.get(id);
          return instance === undefined
            ? Effect.fail(errorFor("storage", `Unknown service ${id}`))
            : instance
                .storage(
                  action.pipe(
                    Effect.mapError(
                      (cause) => new ServiceError({ operation: "storage", message: String(cause) }),
                    ),
                  ),
                )
                .pipe(Effect.mapError((cause) => errorFor("storage", cause)));
        }),
      );
    const snapshotStore = (id: string) =>
      get(id).pipe(
        Effect.flatMap(({ creation }) =>
          creation.service === "database"
            ? makeDatabaseSnapshots({
                instanceRoot: path.join(options.root, id),
                runtime,
                version: creation.config.version,
                stackId: options.saved.id,
                instanceId: id,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError((cause) => errorFor("snapshot", cause)),
              )
            : Effect.fail(errorFor("snapshot", "Snapshots are only supported for databases")),
        ),
      );

    const createService = Effect.fn("Owner.createService")(function* (input: unknown) {
      yield* Ref.get(draining).pipe(
        Effect.flatMap((isDraining) =>
          isDraining ? Effect.fail(errorFor("create", "Owner is draining")) : Effect.void,
        ),
      );
      const creation = yield* Schema.decodeUnknownEffect(ServiceCreation)(input).pipe(
        Effect.mapError((cause) => errorFor("create", cause)),
      );
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => errorFor("identity", cause)),
      );
      yield* addCreation(id, creation);
      yield* Effect.gen(function* () {
        const recipe = yield* recipeReady(creation, id);
        yield* registerReady(id, recipe);
      }).pipe(
        Effect.catch((cause) => removeCreation(id).pipe(Effect.andThen(Effect.fail(cause)))),
        Effect.mapError((cause) => errorFor("register", cause)),
      );
      return { id, creation };
    });

    const configureComposition = Effect.fn("Owner.configureComposition")(function* (
      input: CompositionConfig,
    ) {
      yield* Ref.get(draining).pipe(
        Effect.flatMap((isDraining) => {
          if (isDraining) return Effect.fail(errorFor("configure", "Owner is draining"));
          return Schema.decodeEffect(Orchestrator.CompositionConfig)(input).pipe(
            Effect.mapError((cause) => errorFor("configure", cause)),
          );
        }),
        Effect.tap((value) =>
          orchestrator
            .configure(value)
            .pipe(Effect.mapError((cause) => errorFor("configure", cause))),
        ),
        Effect.tap((value) => Ref.set(composition, value)),
        Effect.tap((value) => persistComposition(value)),
        Effect.asVoid,
      );
    });

    const updateCreation = Effect.fn("Owner.updateCreation")(function* (
      id: string,
      inputs: Record<string, string>,
    ) {
      return yield* getCreation(id).pipe(
        Effect.flatMap((creation) => mergeInputs(creation, inputs)),
        Effect.mapError((cause) => errorFor("supabase", cause)),
        Effect.tap((creation) => persistCreation(id, creation)),
        Effect.map((creation) => ({ id, creation })),
      );
    });

    const supabaseComposition = Effect.fn("Owner.supabaseComposition")(
      (inputs: ReadonlyArray<ServiceCreation>) =>
        makeSupabaseComposition(
          {
            currentComposition: Ref.get(composition),
            create: (creation) => createService(creation).pipe(Effect.mapError(supabaseError)),
            bind: (id) =>
              orchestrator.get(id).pipe(
                Effect.flatMap((registered) => registered.bind),
                Effect.mapError(supabaseError),
              ),
            address: (id, endpoint, from) =>
              Ref.get(namespaces).pipe(
                Effect.flatMap((values) => {
                  const namespace = values.get(id);
                  return namespace === undefined
                    ? Effect.fail(supabaseError("Service namespace is missing"))
                    : namespace.address(endpoint, from).pipe(
                        Effect.map(({ host, port }) => publicUrl(host, port)),
                        Effect.mapError(supabaseError),
                      );
                }),
              ),
            output: (id, name) =>
              orchestrator.get(id).pipe(
                Effect.flatMap((registered) => {
                  const output = registered.outputs[name];
                  return output === undefined
                    ? Effect.fail(supabaseError(`Missing output ${name}`))
                    : output.pipe(Effect.mapError(supabaseError));
                }),
                Effect.mapError(supabaseError),
              ),
            updateCreation: (id, values) =>
              updateCreation(id, values).pipe(Effect.mapError(supabaseError)),
            configure: (configuration) =>
              configureComposition(configuration).pipe(Effect.mapError(supabaseError)),
          },
          inputs,
        ).pipe(
          Effect.mapError((cause) => {
            if (cause instanceof OwnerError) return cause;
            if (cause instanceof SupabaseCompositionError && cause.cause instanceof OwnerError)
              return cause.cause;
            return errorFor("supabase", cause);
          }),
        ),
    );

    const prepare = Effect.fn("Owner.prepare")(function* (id: string) {
      return yield* getRecipe(id).pipe(
        Effect.flatMap((recipe) => recipe.definition.prepare?.(recipe.creation) ?? Effect.void),
        Effect.mapError((cause) => errorFor("prepare", cause)),
      );
    });
    const start = Effect.fn("Owner.start")((id: string) =>
      operation("start", orchestrator.start(id)),
    );
    const ready = Effect.fn("Owner.ready")((id: string) =>
      operation("ready", orchestrator.get(id).pipe(Effect.flatMap((value) => value.core.ready))),
    );
    const stop = Effect.fn("Owner.stop")((id: string) => operation("stop", orchestrator.stop(id)));
    const restart = Effect.fn("Owner.restart")((id: string, input?: unknown) =>
      operation(
        "restart",
        input === undefined ? orchestrator.restart(id) : orchestrator.restart(id, input),
      ),
    );
    const destroy = Effect.fn("Owner.destroy")((id: string) =>
      operation("destroy", orchestrator.destroy(id)),
    );
    const credentials = Effect.fn("Owner.credentials")((id: string, from: "host" | "runtime") =>
      get(id).pipe(
        Effect.flatMap(({ creation }) =>
          Ref.get(namespaces).pipe(
            Effect.flatMap((values) => {
              const namespace = values.get(id);
              if (namespace === undefined)
                return Effect.fail(errorFor("credentials", "Service namespace is missing"));
              const address = (endpoint: string, source: "host" | "runtime") =>
                namespace.address(endpoint, source).pipe(
                  Effect.mapError(
                    (cause) =>
                      new EndpointError({
                        message: cause instanceof Error ? cause.message : String(cause),
                        cause,
                      }),
                  ),
                );
              const password = () =>
                getCreation(id).pipe(
                  Effect.flatMap((value) =>
                    value.service === "database"
                      ? Effect.succeed(Redacted.value(value.config.databasePassword))
                      : Effect.fail(
                          new EndpointError({ message: "Credentials require a database" }),
                        ),
                  ),
                  Effect.mapError((cause) =>
                    cause instanceof EndpointError
                      ? cause
                      : new EndpointError({
                          message: cause instanceof Error ? cause.message : String(cause),
                          cause,
                        }),
                  ),
                );
              return credentialsFor(creation, address, password, from).pipe(
                Effect.mapError((cause) => errorFor("credentials", cause)),
              );
            }),
          ),
        ),
      ),
    );
    const compose = Effect.fn("Owner.compose")((creations: ReadonlyArray<ServiceCreation>) =>
      compositionGate.withPermits(1)(supabaseComposition(creations)),
    );
    const configure = Effect.fn("Owner.configure")((input: CompositionConfig) =>
      compositionGate.withPermits(1)(configureComposition(input)),
    );
    const compositionStart = orchestrator.startComposition.pipe(
      Effect.mapError((cause) => errorFor("start", cause)),
      Effect.flatMap((values) => Effect.forEach(values, (value) => observation(value.id))),
      Effect.withSpan("Owner.startComposition"),
    );
    const compositionStop = orchestrator.stopComposition.pipe(
      Effect.mapError((cause) => errorFor("stop", cause)),
      Effect.flatMap((values) => Effect.forEach(values, (value) => observation(value.id))),
      Effect.withSpan("Owner.stopComposition"),
    );
    const compositionRestart = orchestrator.restartComposition.pipe(
      Effect.mapError((cause) => errorFor("restart", cause)),
      Effect.flatMap((values) => Effect.forEach(values, (value) => observation(value.id))),
      Effect.withSpan("Owner.restartComposition"),
    );
    const exportSnapshot = Effect.fn("Owner.exportSnapshot")((id: string, destination: string) =>
      snapshotStore(id).pipe(
        Effect.flatMap((store) =>
          storage(
            id,
            store
              .exportSnapshot({ destination })
              .pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
          ),
        ),
      ),
    );
    const restoreSnapshot = Effect.fn("Owner.restoreSnapshot")((id: string, source: string) =>
      snapshotStore(id).pipe(
        Effect.flatMap((store) =>
          storage(
            id,
            store
              .restoreSnapshot({ source })
              .pipe(Effect.mapError((cause) => errorFor("snapshot", cause))),
          ),
        ),
      ),
    );
    const stopNamespace = operation("stopNamespace", orchestrator.stopNamespace).pipe(
      Effect.withSpan("Owner.stopNamespace"),
    );
    const destroyNamespace = operation(
      "destroyNamespace",
      orchestrator.destroyNamespace.pipe(
        Effect.andThen(network.release),
        Effect.andThen(options.state.remove(options.saved.id)),
      ),
    ).pipe(Effect.withSpan("Owner.destroyNamespace"));
    const setDraining = Effect.fn("Owner.setDraining")((value: boolean) =>
      Ref.set(draining, value).pipe(Effect.mapError((cause) => errorFor("draining", cause))),
    );
    const getServing = Effect.gen(function* () {
      return !(yield* Ref.get(draining));
    }).pipe(Effect.withSpan("Owner.getServing"));

    const owner: Interface = {
      services: {
        create: createService,
        get,
        list: Ref.get(recipes).pipe(
          Effect.map((values) =>
            [...values].map(([id, recipe]) => ({ id, creation: recipe.creation })),
          ),
          Effect.mapError((cause) => errorFor("list", cause)),
        ),
      },
      core: {
        get: observation,
        status: observation,
        followStatus: (id) =>
          Stream.unwrap(
            orchestrator.get(id).pipe(
              Effect.map((instance) => instance.core.observation),
              Effect.mapError((cause) => errorFor("status", cause)),
            ),
          ).pipe(Stream.mapEffect((value) => enrichObservation(id, value))),
        prepare,
        logs: (id) =>
          Stream.unwrap(
            getRecipe(id).pipe(
              Effect.map((recipe) => recipe.logs),
              Effect.mapError((cause) => errorFor("logs", cause)),
            ),
          ).pipe(Stream.mapError((cause) => errorFor("logs", cause))),
        start,
        ready,
        stop,
        restart,
        destroy,
      },
      composition: {
        supabase: compose,
        configure,
        get: Ref.get(composition),
        start: compositionStart,
        stop: compositionStop,
        restart: compositionRestart,
      },
      credentials,
      snapshots: {
        exportSnapshot,
        restoreSnapshot,
      },
      namespace: {
        stop: stopNamespace,
        destroy: destroyNamespace,
      },
      setDraining,
      getServing,
    };
    return owner;
  });

export const layer = (options: Omit<OwnerOptions, "state">) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* State.Service;
      const orchestrator = yield* Orchestrator.Service;
      const network = yield* Network.Service;
      return Service.of(
        yield* makeOwnerWithDependencies({ ...options, state }, orchestrator, network),
      );
    }),
  ).pipe(
    Layer.provide(Layer.fresh(Orchestrator.layer)),
    Layer.provide(Network.layer({ stackId: options.saved.id, runtime: options.saved.runtime })),
  );

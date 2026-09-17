import { NodeServices } from "@effect/platform-node";
import { Crypto, Effect, FileSystem, Layer, Option, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createStack as createEffectStack,
  discoverStacks as discoverEffectStacks,
  findStack as findEffectStack,
  inspectStack as inspectEffectStack,
  listStacks as listEffectStacks,
  openStack as openEffectStack,
  type EffectStack,
  type CreateStackOptions,
  type FindStackOptions,
  type ListStacksOptions,
  type StackDiscoveryResult,
  type StackDiscoveryIssue,
  type PrepareStackOptions,
  type StartStackOptions,
  type RestartStackOptions,
  type ServiceConfigUpdate,
} from "./EffectStack.ts";
import type { StackConfig } from "./Config.ts";
import { StackConfigSchema } from "./Config.ts";
import {
  createTestStackWith,
  type CreateTestStackOptions,
  TestStackOperationError,
} from "./Testing.ts";
import { PromiseStackCredentialsSchema, type PromiseStackCredentials } from "./Credentials.ts";
import type { LogQuery, StackLogBatch, StackLogEntry } from "./Logs.ts";
import type { StackDescriptor, StackInspection, StackStatus } from "./Status.ts";
import type { StackId } from "./StackId.ts";
import type { PrepareStackResult } from "./EffectStack.ts";
import { InvalidStackConfigError } from "./Errors.ts";
import { StackRuntimeEnvironment, type StackRuntimeEnvironmentValue } from "../state/Ownership.ts";
import type {
  ServiceCollection,
  ServiceKind,
  ServiceRef,
  ServiceInstance,
  AnyServiceInstance,
  CreateServiceOptions,
  ServiceConfig,
  AnyCreateServiceOptions,
  AnyEffectServiceConfig,
  EffectServiceConfig,
} from "./Service.ts";
import { EffectCreateServiceOptionsSchema, ServiceConfigSchemas } from "./Service.ts";

/** Recursively replaces Effect `Redacted` leaves with their plain value. */
type Unredacted<T> =
  T extends Redacted.Redacted<infer Value>
    ? Unredacted<Value>
    : T extends readonly (infer Item)[]
      ? ReadonlyArray<Unredacted<Item>>
      : T extends object
        ? {
            readonly [
              Key in keyof T as Exclude<T[Key], undefined> extends never ? never : Key
            ]: Unredacted<T[Key]>;
          }
        : T;

export type PromiseStackConfig = Unredacted<StackConfig>;
export type PromiseStartStackOptions = StartStackOptions;
export type PromiseCreateStackOptions = Omit<CreateStackOptions, "initialConfig"> & {
  readonly initialConfig: PromiseStackConfig;
};
export type PromiseOpenStackOptions = {
  readonly initialConfig?: PromiseStackConfig;
};
export type PromiseServiceSelection = import("./EffectStack.ts").ServiceSelection;
export type PromiseServiceConfigUpdate = {
  [K in ServiceKind]: {
    readonly id: import("./ServiceInstanceId.ts").ServiceInstanceId;
    readonly service: K;
    readonly config: ServiceConfig<K>;
  };
}[ServiceKind];
export type PromiseRestartStackOptions =
  | { readonly services?: never; readonly config?: PromiseStackConfig }
  | {
      readonly services: ReadonlyArray<import("./ServiceInstanceId.ts").ServiceInstanceId>;
      readonly updates?: ReadonlyArray<PromiseServiceConfigUpdate>;
      readonly config?: never;
    };

export interface PromiseInspectStackOptions {
  readonly config?: PromiseStackConfig;
}
export type PromisePrepareStackOptions = Omit<PrepareStackOptions, "config"> & {
  readonly config?: PromiseStackConfig;
};

export type PromiseCreateTestStackOptions = Omit<
  CreateTestStackOptions,
  "config" | "setupProject"
> & {
  readonly config?: PromiseStackConfig;
  readonly setupProject?: (projectRoot: string) => Promise<void>;
};

export type PromiseTestStack = PromiseStack &
  AsyncDisposable & {
    readonly stateRoot: string;
  };

export interface PromiseStack {
  readonly id: StackId;
  readonly services: ServiceCollection;
  readonly status: () => Promise<StackStatus>;
  readonly followStatus: () => AsyncIterable<StackStatus>;
  readonly credentials: () => Promise<PromiseStackCredentials>;
  readonly prepare: (options?: PromisePrepareStackOptions) => Promise<PrepareStackResult>;
  readonly start: (options?: PromiseStartStackOptions) => Promise<StackStatus>;
  readonly sleep: (options?: PromiseServiceSelection) => Promise<StackStatus>;
  readonly stop: (options?: PromiseServiceSelection) => Promise<StackStatus>;
  readonly restart: (options?: PromiseRestartStackOptions) => Promise<StackStatus>;
  readonly destroy: (options?: PromiseServiceSelection) => Promise<void>;
  readonly logs: (query?: LogQuery) => Promise<StackLogBatch>;
  readonly followLogs: (query?: LogQuery) => AsyncIterable<StackLogEntry>;
}

interface PromiseStackApi {
  readonly createStack: (options: PromiseCreateStackOptions) => Promise<PromiseStack>;
  readonly openStack: (id: StackId, options?: PromiseOpenStackOptions) => Promise<PromiseStack>;
  readonly findStack: (options: FindStackOptions) => Promise<StackDescriptor | undefined>;
  readonly listStacks: (options?: ListStacksOptions) => Promise<ReadonlyArray<StackDescriptor>>;
  readonly discoverStacks: (options?: ListStacksOptions) => Promise<StackDiscoveryResult>;
  readonly inspectStack: (
    id: StackId,
    options?: PromiseInspectStackOptions,
  ) => Promise<StackInspection>;
}

type PlatformLayer = typeof NodeServices.layer;
type RuntimeRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

// Turns plain JSON config values into the Redacted values the Effect handle expects.
const stackConfigJsonCodec = Schema.toCodecJson(StackConfigSchema);
const decodePromiseConfig = (
  input: PromiseStackConfig,
): Effect.Effect<StackConfig, InvalidStackConfigError> =>
  Schema.decodeEffect(stackConfigJsonCodec)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStackConfigError({
          message: `Invalid stack config: ${String(cause)}`,
          cause,
        }),
    ),
  );

function decodePromiseServiceConfig<K extends ServiceKind>(
  service: K,
  config: ServiceConfig<K>,
): Effect.Effect<EffectServiceConfig<K>, InvalidStackConfigError>;
function decodePromiseServiceConfig(
  service: ServiceKind,
  config: import("./Service.ts").AnyServiceConfig,
): Effect.Effect<AnyEffectServiceConfig, InvalidStackConfigError> {
  const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
    schema: S,
  ): Effect.Effect<S["Type"], InvalidStackConfigError> =>
    Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(config, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new InvalidStackConfigError({
            message: `Invalid ${service} service config: ${String(cause)}`,
            cause,
          }),
      ),
    );
  switch (service) {
    case "database":
      return decode(ServiceConfigSchemas.database);
    case "rest":
      return decode(ServiceConfigSchemas.rest);
    case "auth":
      return decode(ServiceConfigSchemas.auth);
    case "realtime":
      return decode(ServiceConfigSchemas.realtime);
    case "storage":
      return decode(ServiceConfigSchemas.storage);
    case "functions":
      return decode(ServiceConfigSchemas.functions);
    case "studio":
      return decode(ServiceConfigSchemas.studio);
    case "mail":
      return decode(ServiceConfigSchemas.mail);
    case "analytics":
      return decode(ServiceConfigSchemas.analytics);
    case "pooler":
      return decode(ServiceConfigSchemas.pooler);
  }
}

const decodePromiseRestartOptions = (
  options: PromiseRestartStackOptions | undefined,
): Effect.Effect<RestartStackOptions, InvalidStackConfigError> => {
  if (options === undefined) return Effect.succeed({});
  if (options.services === undefined)
    return options.config === undefined
      ? Effect.succeed({})
      : decodePromiseConfig(options.config).pipe(Effect.map((config) => ({ config })));
  const updates = options.updates ?? [];
  const decodeUpdate = (
    update: PromiseServiceConfigUpdate,
  ): Effect.Effect<ServiceConfigUpdate, InvalidStackConfigError> =>
    (() => {
      switch (update.service) {
        case "database":
          return decodePromiseServiceConfig("database", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "database", config })),
          );
        case "rest":
          return decodePromiseServiceConfig("rest", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "rest", config })),
          );
        case "auth":
          return decodePromiseServiceConfig("auth", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "auth", config })),
          );
        case "realtime":
          return decodePromiseServiceConfig("realtime", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "realtime", config })),
          );
        case "storage":
          return decodePromiseServiceConfig("storage", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "storage", config })),
          );
        case "functions":
          return decodePromiseServiceConfig("functions", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "functions", config })),
          );
        case "studio":
          return decodePromiseServiceConfig("studio", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "studio", config })),
          );
        case "mail":
          return decodePromiseServiceConfig("mail", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "mail", config })),
          );
        case "analytics":
          return decodePromiseServiceConfig("analytics", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "analytics", config })),
          );
        case "pooler":
          return decodePromiseServiceConfig("pooler", update.config).pipe(
            Effect.map((config) => ({ id: update.id, service: "pooler", config })),
          );
      }
    })();
  return Effect.forEach(updates, decodeUpdate).pipe(
    Effect.map((decoded) => ({
      services: options.services,
      ...(decoded.length === 0 ? {} : { updates: decoded }),
    })),
  );
};

/** Recursively unwraps every Redacted value at the Promise boundary. */
function unredact<T>(input: T): Unredacted<T>;
function unredact(input: unknown): unknown {
  if (Redacted.isRedacted(input)) return unredact(Redacted.value(input));
  if (Array.isArray(input)) return input.map(unredact);
  if (typeof input === "object" && input !== null) {
    const output: Record<PropertyKey, unknown> = {};
    for (const [key, value] of Object.entries(input)) output[key] = unredact(value);
    return output;
  }
  return input;
}

const adaptStream = <A, E>(stream: Stream.Stream<A, E>): AsyncIterable<A> =>
  Stream.toAsyncIterable(stream);

const invokePromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** Adapts an already-created Effect handle; exported for facade integration tests. */
export const adaptEffectStack = (effectStack: EffectStack): PromiseStack => {
  const invoke = invokePromise;
  const withConfig = <A>(
    options: { readonly config?: PromiseStackConfig } | undefined,
    operation: (config?: StackConfig) => Effect.Effect<A, Error>,
  ): Effect.Effect<A, Error> =>
    Effect.gen(function* () {
      const config =
        options?.config === undefined ? undefined : yield* decodePromiseConfig(options.config);
      return yield* operation(config);
    });
  const adaptService = <K extends ServiceKind>(
    service: import("./Service.ts").EffectServiceInstance<K>,
  ): ServiceInstance<K> => ({
    id: service.id,
    service: service.service,
    name: service.name,
    describe: () => invoke(service.describe),
    status: () => invoke(service.status),
    credentials: () => invoke(service.credentials),
    prepare: () => invoke(service.prepare),
    start: () => invoke(service.start),
    sleep: () => invoke(service.sleep),
    stop: () => invoke(service.stop),
    restart: (options) =>
      options?.config === undefined
        ? invoke(service.restart())
        : invoke(
            decodePromiseServiceConfig(service.service, options.config).pipe(
              Effect.flatMap((config) => service.restart({ config })),
            ),
          ),
    destroy: () => invoke(service.destroy),
    exportSnapshot: (options) => invoke(service.exportSnapshot(options)),
    restoreSnapshot: (options) => invoke(service.restoreSnapshot(options)),
    logs: (query) => invoke(service.logs(query)),
    followLogs: (query) => adaptStream(service.followLogs(query)),
    followStatus: () => adaptStream(service.followStatus),
  });
  function createService<K extends ServiceKind>(
    options: CreateServiceOptions<K>,
  ): Promise<ServiceInstance<K>>;
  function createService(options: AnyCreateServiceOptions): Promise<AnyServiceInstance> {
    return invoke(
      Effect.gen(function* () {
        const config = yield* decodePromiseServiceConfig(options.service, options.config);
        const decoded = yield* Schema.decodeUnknownEffect(EffectCreateServiceOptionsSchema)({
          ...options,
          config,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new InvalidStackConfigError({
                message: `Invalid ${options.service} service creation options: ${String(cause)}`,
                cause,
              }),
          ),
        );
        switch (decoded.service) {
          case "database":
            return adaptService(yield* effectStack.services.create(decoded));
          case "rest":
            return adaptService(yield* effectStack.services.create(decoded));
          case "auth":
            return adaptService(yield* effectStack.services.create(decoded));
          case "realtime":
            return adaptService(yield* effectStack.services.create(decoded));
          case "storage":
            return adaptService(yield* effectStack.services.create(decoded));
          case "functions":
            return adaptService(yield* effectStack.services.create(decoded));
          case "studio":
            return adaptService(yield* effectStack.services.create(decoded));
          case "mail":
            return adaptService(yield* effectStack.services.create(decoded));
          case "analytics":
            return adaptService(yield* effectStack.services.create(decoded));
          case "pooler":
            return adaptService(yield* effectStack.services.create(decoded));
        }
      }),
    );
  }
  const services: ServiceCollection = {
    create: createService,
    get: (ref: ServiceRef) =>
      invoke(effectStack.services.get(ref)).then((service): AnyServiceInstance => {
        switch (service.service) {
          case "database":
            return adaptService(service);
          case "rest":
            return adaptService(service);
          case "auth":
            return adaptService(service);
          case "realtime":
            return adaptService(service);
          case "storage":
            return adaptService(service);
          case "functions":
            return adaptService(service);
          case "studio":
            return adaptService(service);
          case "mail":
            return adaptService(service);
          case "analytics":
            return adaptService(service);
          case "pooler":
            return adaptService(service);
        }
      }),
    list: () => invoke(effectStack.services.list),
  };
  return {
    id: effectStack.id,
    services,
    status: () => invoke(effectStack.status),
    followStatus: () => adaptStream(effectStack.followStatus),
    credentials: () =>
      invoke(effectStack.credentials).then((value) =>
        Schema.decodeSync(PromiseStackCredentialsSchema)(unredact(value)),
      ),
    prepare: (options) =>
      invoke(
        withConfig(options, (config) =>
          effectStack.prepare(
            options === undefined
              ? undefined
              : {
                  ...(options.services === undefined ? {} : { services: options.services }),
                  ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
                  ...(config === undefined ? {} : { config }),
                },
          ),
        ),
      ),
    start: (options) => invoke(effectStack.start(options)),
    sleep: (options) => invoke(effectStack.sleep(options)),
    stop: (options) => invoke(effectStack.stop(options)),
    restart: (options) =>
      invoke(
        decodePromiseRestartOptions(options).pipe(
          Effect.flatMap((decoded) => effectStack.restart(decoded)),
        ),
      ),
    destroy: (options) => invoke(effectStack.destroy(options)),
    logs: (query) => invoke(effectStack.logs(query)),
    followLogs: (query) => adaptStream(effectStack.followLogs(query)),
  };
};

export const makePromiseApi = (
  platformLayer: PlatformLayer = NodeServices.layer,
  runtimeEnvironment?: StackRuntimeEnvironmentValue,
): PromiseStackApi => {
  const providedLayer =
    runtimeEnvironment === undefined
      ? platformLayer
      : Layer.mergeAll(platformLayer, Layer.succeed(StackRuntimeEnvironment, runtimeEnvironment));
  const run = <A, E>(effect: Effect.Effect<A, E, RuntimeRequirements>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(providedLayer)));

  const createOrOpen = (
    effect: Effect.Effect<EffectStack, Error, RuntimeRequirements>,
  ): Promise<PromiseStack> => run(effect).then(adaptEffectStack);
  return {
    createStack: (options) =>
      (() => {
        const { initialConfig, ...baseOptions } = options;
        return createOrOpen(
          decodePromiseConfig(initialConfig).pipe(
            Effect.flatMap((decoded) =>
              createEffectStack({ ...baseOptions, initialConfig: decoded }),
            ),
          ),
        );
      })(),
    openStack: (id, options) =>
      createOrOpen(
        options?.initialConfig === undefined
          ? openEffectStack(id)
          : decodePromiseConfig(options.initialConfig).pipe(
              Effect.flatMap((initialConfig) => openEffectStack(id, { initialConfig })),
            ),
      ),
    findStack: (options) =>
      run(findEffectStack(options)).then((value) => Option.getOrUndefined(value)),
    listStacks: (options) => run(listEffectStacks(options)),
    discoverStacks: (options) => run(discoverEffectStacks(options)),
    inspectStack: (id, options) =>
      run(
        options?.config === undefined
          ? inspectEffectStack(id)
          : decodePromiseConfig(options.config).pipe(
              Effect.flatMap((config) => inspectEffectStack(id, { config })),
            ),
      ),
  };
};

const defaultApi = makePromiseApi();
export const createStack = defaultApi.createStack;
export const openStack = defaultApi.openStack;
export const findStack = defaultApi.findStack;
export const listStacks = defaultApi.listStacks;
export const discoverStacks = defaultApi.discoverStacks;
export const inspectStack = defaultApi.inspectStack;

/** Creates an isolated test stack through the root Promise facade. */
export const createTestStack = (
  options: PromiseCreateTestStackOptions = {},
): Promise<PromiseTestStack> => {
  const promise = Effect.runPromise(
    Effect.gen(function* () {
      const { config: promiseConfig, setupProject, ...baseOptions } = options;
      const config =
        promiseConfig === undefined ? undefined : yield* decodePromiseConfig(promiseConfig);
      const effectStack = yield* createTestStackWith({
        ...baseOptions,
        ...(config === undefined ? {} : { config }),
        ...(setupProject === undefined
          ? {}
          : {
              setupProject: (projectRoot: string) =>
                Effect.tryPromise({
                  try: () => setupProject(projectRoot),
                  catch: (cause) =>
                    new TestStackOperationError({
                      message: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
                }),
            }),
      });
      const promiseStack = adaptEffectStack(effectStack);
      return {
        ...promiseStack,
        stateRoot: effectStack.stateRoot,
        [Symbol.asyncDispose]: () => invokePromise(effectStack.destroy()),
      } satisfies PromiseTestStack;
    }),
  );
  return promise.catch((error: unknown) => {
    let cause = error;
    while (cause instanceof TestStackOperationError) cause = cause.cause;
    if (cause !== error) throw cause;
    throw error;
  });
};

export type {
  CreateStackOptions,
  FindStackOptions,
  ListStacksOptions,
  StackDiscoveryIssue,
  StackDiscoveryResult,
};

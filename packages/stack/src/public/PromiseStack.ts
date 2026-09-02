import { NodeServices } from "@effect/platform-node";
import {
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Scope,
  Schema,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createStack as createEffectStack,
  findStack as findEffectStack,
  inspectStack as inspectEffectStack,
  listStacks as listEffectStacks,
  openStack as openEffectStack,
  type EffectStack,
  type CreateStackOptions,
  type OpenStackOptions,
  type FindStackOptions,
  type ListStacksOptions,
  type PrepareStackOptions,
  type StartStackOptions,
} from "./EffectStack.ts";
import type { StackConfig } from "./Config.ts";
import { StackConfigSchema } from "./Config.ts";
import { PromiseStackCredentialsSchema, type PromiseStackCredentials } from "./Credentials.ts";
import type { LogQuery, StackLogBatch, StackLogEntry } from "./Logs.ts";
import type { StackDescriptor, StackInspection, StackStatus } from "./Status.ts";
import type { StackId } from "./StackId.ts";
import type { PreparedCapability, PrepareStackResult } from "./EffectStack.ts";
import { InvalidStackConfigError } from "./Errors.ts";
import { StackRuntimeEnvironment, type StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

// Promise methods are the deliberate outer boundary of this package.
// oxlint-disable effecttsgo/async-function -- Promise facade methods must expose Promise/AsyncIterable APIs.
// oxlint-disable effecttsgo/any-unknown-in-error-context -- Promise callers receive native rejection values.

/** Recursively replaces Effect `Redacted` leaves with their plain value. */
type Unredacted<T> =
  T extends Redacted.Redacted<infer Value>
    ? Unredacted<Value>
    : T extends readonly (infer Item)[]
      ? ReadonlyArray<Unredacted<Item>>
      : T extends object
        ? { readonly [Key in keyof T]: Unredacted<T[Key]> }
        : T;

export type PromiseStackConfig = Unredacted<StackConfig>;
export type PromiseStartStackOptions = Omit<StartStackOptions, "config"> & {
  readonly config?: PromiseStackConfig;
};
export type PromisePrepareStackOptions = Omit<PrepareStackOptions, "config"> & {
  readonly config?: PromiseStackConfig;
};

export interface PromiseStack {
  readonly id: StackId;
  readonly status: () => Promise<StackStatus>;
  readonly credentials: () => Promise<PromiseStackCredentials>;
  readonly prepare: (options?: PromisePrepareStackOptions) => Promise<PrepareStackResult>;
  readonly start: (options?: PromiseStartStackOptions) => Promise<StackStatus>;
  readonly restart: (options?: PromiseStartStackOptions) => Promise<StackStatus>;
  readonly stop: () => Promise<void>;
  readonly destroy: () => Promise<void>;
  readonly logs: (query?: LogQuery) => Promise<StackLogBatch>;
  readonly followLogs: (query?: LogQuery) => AsyncIterable<StackLogEntry>;
}

export interface PromiseStackApi {
  readonly createStack: (options: CreateStackOptions) => Promise<PromiseStack>;
  readonly openStack: (id: StackId, options?: OpenStackOptions) => Promise<PromiseStack>;
  readonly findStack: (options: FindStackOptions) => Promise<StackDescriptor | undefined>;
  readonly listStacks: (options?: ListStacksOptions) => Promise<ReadonlyArray<StackDescriptor>>;
  readonly inspectStack: (id: StackId) => Promise<StackInspection>;
}

type PlatformLayer = typeof NodeServices.layer;
type RuntimeRequirements =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

// Canonical JSON decoding follows all schema transformations, including Redacted
// declarations nested in records and arrays. At this explicit Promise boundary,
// plain JSON strings become Effect Redacted values for the Effect handle.
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

/** Adapts an already-created Effect handle; exported for facade integration tests. */
export const adaptEffectStack = (effectStack: EffectStack): PromiseStack => {
  const invoke = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);
  const withConfig = <A>(
    options: { readonly config?: PromiseStackConfig } | undefined,
    operation: (config?: StackConfig) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, unknown> =>
    Effect.gen(function* () {
      const config =
        options?.config === undefined ? undefined : yield* decodePromiseConfig(options.config);
      return yield* operation(config);
    });
  return {
    id: effectStack.id,
    status: () => invoke(effectStack.status()),
    credentials: () =>
      invoke(effectStack.credentials()).then((value) =>
        Schema.decodeSync(PromiseStackCredentialsSchema)(unredact(value)),
      ),
    prepare: (options) =>
      invoke(
        withConfig(options, (config) =>
          effectStack.prepare(
            options === undefined
              ? undefined
              : {
                  ...(options.capabilities === undefined
                    ? {}
                    : { capabilities: options.capabilities }),
                  ...(config === undefined ? {} : { config }),
                },
          ),
        ),
      ),
    start: (options) =>
      invoke(
        withConfig(options, (config) =>
          options === undefined
            ? effectStack.start()
            : effectStack.start(config === undefined ? {} : { config }),
        ),
      ),
    restart: (options) =>
      invoke(
        withConfig(options, (config) =>
          options === undefined
            ? effectStack.restart()
            : effectStack.restart(config === undefined ? {} : { config }),
        ),
      ),
    stop: () => invoke(effectStack.stop()),
    destroy: () => invoke(effectStack.destroy()),
    logs: (query) => invoke(effectStack.logs(query)),
    followLogs: (query) => adaptStream(effectStack.followLogs(query)),
  };
};

const makeScope = () => Effect.runPromise(Scope.make());

export const makePromiseApi = (
  platformLayer: PlatformLayer = NodeServices.layer,
  runtimeEnvironment?: StackRuntimeEnvironmentValue,
): PromiseStackApi => {
  const providedLayer =
    runtimeEnvironment === undefined
      ? platformLayer
      : Layer.mergeAll(platformLayer, Layer.succeed(StackRuntimeEnvironment, runtimeEnvironment));
  const run = async <A, E>(
    effect: Effect.Effect<A, E, RuntimeRequirements>,
    scope?: Scope.Scope,
  ): Promise<A> => {
    const ownedScope = scope === undefined;
    const actualScope = scope ?? (await makeScope());
    try {
      return await Effect.runPromise(
        effect.pipe(Effect.provide(providedLayer), Effect.provideService(Scope.Scope, actualScope)),
      );
    } finally {
      if (ownedScope) await Effect.runPromise(Scope.close(actualScope, Exit.void));
    }
  };

  const createOrOpen = async (
    effect: Effect.Effect<EffectStack, unknown, RuntimeRequirements>,
  ): Promise<PromiseStack> => adaptEffectStack(await run(effect));
  return {
    createStack: (options) => createOrOpen(createEffectStack(options)),
    openStack: (id, options) => createOrOpen(openEffectStack(id, options)),
    findStack: (options) =>
      run(findEffectStack(options)).then((value) => Option.getOrUndefined(value)),
    listStacks: (options) => run(listEffectStacks(options)),
    inspectStack: (id) => run(inspectEffectStack(id)),
  };
};

const defaultApi = makePromiseApi();
export const createStack = defaultApi.createStack;
export const openStack = defaultApi.openStack;
export const findStack = defaultApi.findStack;
export const listStacks = defaultApi.listStacks;
export const inspectStack = defaultApi.inspectStack;

export type { CreateStackOptions, FindStackOptions, ListStacksOptions, PreparedCapability };

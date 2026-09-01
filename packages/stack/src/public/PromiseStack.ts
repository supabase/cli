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
  type FindStackOptions,
  type ListStacksOptions,
  type PrepareStackOptions,
  type StartStackOptions,
} from "./EffectStack.ts";
import type { StackConfig } from "./Config.ts";
import { StackConfigSchema } from "./Config.ts";
import { PromiseStackCredentialsSchema, type PromiseStackCredentials } from "./Credentials.ts";
import type { LogOptions, StackLogEntry } from "./Logs.ts";
import type { StackDescriptor, StackInspection, StackStatus } from "./Status.ts";
import type { StackId } from "./StackId.ts";
import type { PreparedCapability, PrepareStackResult } from "./EffectStack.ts";
import { StackRuntimeEnvironment, type StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

// Promise methods are the deliberate outer boundary of this package.
// oxlint-disable effecttsgo/async-function -- Promise facade methods must expose Promise/AsyncIterable APIs.
// oxlint-disable effecttsgo/any-unknown-in-error-context -- Promise callers receive native rejection values.

/** Recursively replaces Effect `Redacted` leaves with their plain value. */
export type Unredacted<T> =
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
  readonly close: () => Promise<void>;
  readonly watchStatus: () => AsyncIterable<StackStatus>;
  readonly logs: (options?: LogOptions) => AsyncIterable<StackLogEntry>;
}

export interface PromiseStackApi {
  readonly createStack: (options: CreateStackOptions) => Promise<PromiseStack>;
  readonly openStack: (id: StackId) => Promise<PromiseStack>;
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
const decodePromiseConfig = (input: PromiseStackConfig): StackConfig =>
  Schema.decodeSync(stackConfigJsonCodec)(input);

/** Recursively unwraps every Redacted value at the Promise boundary. */
export function unredact<T>(input: T): Unredacted<T>;
export function unredact(input: unknown): unknown {
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
export const adaptEffectStack = (
  effectStack: EffectStack,
  handleScope?: Scope.Scope,
): PromiseStack => {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const active: Set<() => Promise<unknown>> = new Set();
  const closedError = () => new Error("Stack handle is closed");
  const iterable = <A>(stream: Stream.Stream<A, unknown>): AsyncIterable<A> => ({
    [Symbol.asyncIterator]() {
      if (closed) {
        return {
          next: async () => Promise.reject(closedError()),
          return: async () => ({ done: true, value: undefined }),
          throw: async () => Promise.reject(closedError()),
        };
      }
      const iterator = adaptStream(stream)[Symbol.asyncIterator]();
      const cancel = () => Promise.resolve(iterator.return?.());
      active.add(cancel);
      return {
        next: async (...args: [] | [undefined]) => {
          try {
            const result = await iterator.next(...args);
            if (result.done === true) active.delete(cancel);
            return result;
          } catch (error) {
            active.delete(cancel);
            throw error;
          }
        },
        return: async (value?: unknown) => {
          active.delete(cancel);
          return iterator.return?.(value) ?? { done: true, value: undefined };
        },
        throw:
          iterator.throw === undefined
            ? undefined
            : async (error?: unknown) => {
                active.delete(cancel);
                return iterator.throw!(error);
              },
      };
    },
  });
  const invoke = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
    if (closed) return Promise.reject(closedError());
    return Effect.runPromise(effect);
  };
  return {
    id: effectStack.id,
    status: () => invoke(effectStack.status()),
    credentials: () =>
      invoke(effectStack.credentials()).then((value) =>
        Schema.decodeSync(PromiseStackCredentialsSchema)(unredact(value)),
      ),
    prepare: (options) =>
      invoke(
        effectStack.prepare(
          options
            ? {
                ...options,
                config:
                  options.config === undefined ? undefined : decodePromiseConfig(options.config),
              }
            : undefined,
        ),
      ),
    start: (options) =>
      invoke(
        effectStack.start(
          options
            ? {
                config:
                  options.config === undefined ? undefined : decodePromiseConfig(options.config),
              }
            : undefined,
        ),
      ),
    restart: (options) =>
      invoke(
        effectStack.restart(
          options
            ? {
                config:
                  options.config === undefined ? undefined : decodePromiseConfig(options.config),
              }
            : undefined,
        ),
      ),
    stop: () => invoke(effectStack.stop()),
    destroy: () => invoke(effectStack.destroy()),
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        const failures: Array<unknown> = [];
        await Promise.all(
          [...active].map(async (cancel) => {
            try {
              await cancel();
            } catch (error) {
              failures.push(error);
            } finally {
              active.delete(cancel);
            }
          }),
        );
        try {
          await Effect.runPromise(effectStack.close());
        } catch (error) {
          failures.push(error);
        } finally {
          if (handleScope !== undefined) {
            try {
              await Effect.runPromise(Scope.close(handleScope, Exit.void));
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Failed to close stack handle");
      })();
      return closePromise;
    },
    watchStatus: () => iterable(effectStack.watchStatus()),
    logs: (options) => iterable(effectStack.logs(options)),
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
  ): Promise<PromiseStack> => {
    const scope = await makeScope();
    try {
      return adaptEffectStack(await run(effect, scope), scope);
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(error)));
      throw error;
    }
  };
  return {
    createStack: (options) => createOrOpen(createEffectStack(options)),
    openStack: (id) => createOrOpen(openEffectStack(id)),
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

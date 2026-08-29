import { NodeServices } from "@effect/platform-node";
import {
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Redacted,
  Scope,
  Schema,
  SchemaAST,
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

// Promise methods are the deliberate outer boundary of this package.
// oxlint-disable effecttsgo/async-function -- Promise facade methods must expose Promise/AsyncIterable APIs.
// oxlint-disable effecttsgo/any-unknown-in-error-context -- Promise callers receive native rejection values.

/** Recursively replaces Effect `Redacted` leaves with their plain value. */
export type Unredacted<T> = [T] extends [Redacted.Redacted<infer Value>]
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

const isRedactedSchema = (ast: SchemaAST.AST): boolean => {
  if (ast._tag !== "Declaration") return false;
  const representation = ast.annotations?.representation;
  return (
    typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    representation.id === "effect/schema/Redacted"
  );
};

const literalFields = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.PropertySignature> => {
  if (ast._tag !== "Objects") return [];
  return ast.propertySignatures.filter((property) => property.type._tag === "Literal");
};

const isRecord = (input: unknown): input is Record<PropertyKey, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

/** Wraps plain Promise config values according to the Effect config schema. */
const redactBySchema = (ast: SchemaAST.AST, input: unknown): unknown => {
  if (input === undefined || input === null) return input;
  if (isRedactedSchema(ast)) return Redacted.isRedacted(input) ? input : Redacted.make(input);
  switch (ast._tag) {
    case "Objects": {
      if (!isRecord(input)) return input;
      const source = input;
      const output: Record<PropertyKey, unknown> = { ...source };
      const properties = new Map(
        ast.propertySignatures.map((property) => [property.name, property.type]),
      );
      for (const [name, value] of Object.entries(source)) {
        const property = properties.get(name);
        if (property !== undefined) output[name] = redactBySchema(property, value);
        else {
          for (const index of ast.indexSignatures) {
            output[name] = redactBySchema(index.type, value);
            break;
          }
        }
      }
      return output;
    }
    case "Arrays":
      return Array.isArray(input)
        ? input.map((value, index) =>
            redactBySchema(ast.elements[index] ?? ast.rest[0] ?? ast, value),
          )
        : input;
    case "Union": {
      if (input === undefined) return input;
      const branch =
        ast.types.find((candidate) => {
          const fields = literalFields(candidate);
          return (
            fields.length > 0 &&
            fields.every((field) => {
              if (!isRecord(input)) return false;
              const literal = field.type;
              return literal._tag === "Literal" && input[field.name] === literal.literal;
            })
          );
        }) ?? ast.types.find((candidate) => candidate._tag !== "Undefined");
      return branch === undefined ? input : redactBySchema(branch, input);
    }
    case "Suspend":
      return redactBySchema(ast.thunk(), input);
    default:
      return input;
  }
};

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
  const active: Set<() => Promise<unknown>> = new Set();
  const iterable = <A>(stream: Stream.Stream<A, unknown>): AsyncIterable<A> => ({
    [Symbol.asyncIterator]() {
      const iterator = adaptStream(stream)[Symbol.asyncIterator]();
      const cancel = () => Promise.resolve(iterator.return?.());
      active.add(cancel);
      return {
        next: (...args: [] | [undefined]) => iterator.next(...args),
        return: async (value?: unknown) => {
          active.delete(cancel);
          return iterator.return?.(value) ?? { done: true, value: undefined };
        },
        throw: iterator.throw,
      };
    },
  });
  const invoke = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
    if (closed) return Promise.reject(new Error("Stack handle is closed"));
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
                  options.config === undefined
                    ? undefined
                    : Schema.decodeUnknownSync(StackConfigSchema)(
                        redactBySchema(StackConfigSchema.ast, options.config),
                      ),
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
                  options.config === undefined
                    ? undefined
                    : Schema.decodeUnknownSync(StackConfigSchema)(
                        redactBySchema(StackConfigSchema.ast, options.config),
                      ),
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
                  options.config === undefined
                    ? undefined
                    : Schema.decodeUnknownSync(StackConfigSchema)(
                        redactBySchema(StackConfigSchema.ast, options.config),
                      ),
              }
            : undefined,
        ),
      ),
    stop: () => invoke(effectStack.stop()),
    destroy: () => invoke(effectStack.destroy()),
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all([...active].map((cancel) => cancel()));
      try {
        await Effect.runPromise(effectStack.close());
      } finally {
        if (handleScope !== undefined) await Effect.runPromise(Scope.close(handleScope, Exit.void));
      }
    },
    watchStatus: () => iterable(effectStack.watchStatus()),
    logs: (options) => iterable(effectStack.logs(options)),
  };
};

const makeScope = () => Effect.runPromise(Scope.make());

export const makePromiseApi = (
  platformLayer: PlatformLayer = NodeServices.layer,
): PromiseStackApi => {
  const run = async <A, E>(
    effect: Effect.Effect<A, E, RuntimeRequirements>,
    scope?: Scope.Scope,
  ): Promise<A> => {
    const ownedScope = scope === undefined;
    const actualScope = scope ?? (await makeScope());
    try {
      return await Effect.runPromise(
        effect.pipe(Effect.provide(platformLayer), Effect.provideService(Scope.Scope, actualScope)),
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

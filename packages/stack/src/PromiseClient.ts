import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import type * as StackEffect from "./effect.ts";
import { failureMessage } from "./internal/failure-message.ts";
import { StackError } from "./Rpc.ts";
import { ServiceCreationInput as CreationSchema } from "./services/Catalog.ts";
import type { PgProveOptions, PostgresTool } from "./Tools.ts";

/** Optional cancellation ends the caller's wait, or its attached tool job. */
export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** Replaces `Redacted` secrets with their plain values. */
export type Plain<T> =
  T extends Redacted.Redacted<infer A>
    ? A
    : T extends (...args: never) => unknown
      ? T
      : T extends object
        ? { [K in keyof T]: Plain<T[K]> }
        : T;
type PlainArguments<P extends ReadonlyArray<unknown>> = { [K in keyof P]: Plain<P[K]> };

type Effectful = Effect.Effect<unknown, unknown, unknown>;
/**
 * The Promise form of an Effect handle: an Effect becomes a call, an Effect-returning function
 * gains trailing call options and plain inputs, and a Stream becomes an async iterable. Results
 * are data; operations that return handles are adapted explicitly.
 */
export type Promised<T> = T extends Effectful
  ? (options?: CallOptions) => Promise<Effect.Success<T>>
  : T extends Stream.Stream<infer A, unknown, unknown>
    ? () => AsyncIterable<A>
    : T extends (...args: infer P) => infer R
      ? R extends Effectful
        ? (...args: [...PlainArguments<P>, callOptions?: CallOptions]) => Promise<Effect.Success<R>>
        : T
      : T extends object
        ? { readonly [K in keyof T]: Promised<T[K]> }
        : T;

type Kind = StackEffect.ServiceCreationInput["service"];
/** Plain service configuration accepted by non-Effect callers. */
export type ServiceCreationInput = Plain<StackEffect.ServiceCreationInput>;
/** A database instance with stopped-data snapshot operations. */
export interface DatabaseInstance extends Promised<StackEffect.DatabaseInstance> {}
/** Maps creation discriminators to their supported instance operations. */
export type ServiceInstances = {
  readonly [K in Kind]: K extends "database"
    ? DatabaseInstance
    : Promised<StackEffect.ServiceInstances[K]>;
};
/** An individual service; closing the client does not stop this process. */
export type ServiceInstance<K extends Kind = Kind> = ServiceInstances[K];
/** Streaming inputs and awaited output sinks for an attached finite tool. */
export interface ToolOptions {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly pgProve?: PgProveOptions;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => void | Promise<void>;
  readonly stderr: (bytes: Uint8Array) => void | Promise<void>;
}
type DerivedStack = Promised<StackEffect.Stack>;
/** A Promise client; closing the creating client of a session stack destroys the stack. */
export interface Stack extends Omit<DerivedStack, "services" | "composition" | "tools"> {
  readonly services: {
    readonly create: <Input extends ServiceCreationInput>(
      creation: Input,
      options?: CallOptions,
    ) => Promise<ServiceInstances[Input["service"]]>;
    readonly get: (
      ...args: Parameters<DerivedStack["services"]["get"]>
    ) => Promise<ServiceInstance>;
    readonly list: (options?: CallOptions) => Promise<ReadonlyArray<ServiceInstance>>;
  };
  readonly composition: Omit<DerivedStack["composition"], "supabase"> & {
    readonly supabase: (
      ...args: Parameters<DerivedStack["composition"]["supabase"]>
    ) => Promise<ReadonlyArray<ServiceInstance>>;
  };
  readonly tools: Omit<DerivedStack["tools"], "run"> & {
    readonly run: (
      tool: PostgresTool,
      options: ToolOptions,
      callOptions?: CallOptions,
    ) => Promise<Effect.Success<ReturnType<StackEffect.Stack["tools"]["run"]>>>;
  };
  /** Disposes this client and ends its active observation iterators. */
  readonly close: () => Promise<void>;
}

const clientLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
/** Every failure and defect of a cause, so none is hidden behind the first. */
const causeErrors = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
  cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
  );
type ClientServices = Layer.Success<typeof clientLayer>;

/** Runs Effects for one Promise client and owns the scope its handles live in. */
export interface Client {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, ClientServices>,
    options?: CallOptions,
  ) => Promise<A>;
  readonly iterable: <A, E>(stream: Stream.Stream<A, E>) => AsyncIterable<A>;
  readonly close: () => Promise<void>;
}

const makeClient = (
  runtime: ManagedRuntime.ManagedRuntime<ClientServices, never>,
  scope: Scope.Closeable,
): Client => {
  const activeIterators = new Set<() => Promise<void>>();
  let clientClosePromise: Promise<void> | undefined;
  const iterable = <A, E>(stream: Stream.Stream<A, E>): AsyncIterable<A> => ({
    [Symbol.asyncIterator]() {
      if (clientClosePromise !== undefined) throw new Error("Stack client is closed");
      const iterator = runtime
        .runSync(Stream.toAsyncIterableEffect(stream))
        [Symbol.asyncIterator]();
      const iteratorReturn = iterator.return;
      const iteratorThrow = iterator.throw;
      let iteratorClosePromise: Promise<IteratorResult<A>> | undefined;
      let dispose: () => Promise<void>;
      const close = (): Promise<IteratorResult<A>> => {
        if (iteratorClosePromise !== undefined) return iteratorClosePromise;
        const promise: Promise<IteratorResult<A>> = (
          iteratorReturn === undefined
            ? Promise.resolve<IteratorResult<A>>({ done: true, value: undefined })
            : iteratorReturn(undefined)
        ).finally(() => activeIterators.delete(dispose));
        iteratorClosePromise = promise;
        return promise;
      };
      dispose = () => close().then(() => undefined);
      activeIterators.add(dispose);
      const settle = (result: Promise<IteratorResult<A>>) =>
        result.then(
          (next) => {
            if (next.done) activeIterators.delete(dispose);
            return next;
          },
          (error: unknown) => {
            activeIterators.delete(dispose);
            return Promise.reject(error);
          },
        );
      return {
        next: (value?: unknown) => settle(iterator.next(value)),
        return: close,
        ...(iteratorThrow === undefined
          ? {}
          : { throw: (error?: unknown) => settle(iteratorThrow(error)) }),
      };
    },
  });
  const failures: Array<unknown> = [];
  const record = (error: unknown) => {
    failures.push(error);
  };
  return {
    run: (effect, options) => runtime.runPromise(effect, options),
    iterable,
    close: () => {
      if (clientClosePromise !== undefined) return clientClosePromise;
      clientClosePromise = Promise.allSettled([...activeIterators].map((dispose) => dispose()))
        .then((iterators) => {
          for (const result of iterators) if (result.status === "rejected") record(result.reason);
          return runtime.runPromiseExit(Scope.close(scope, Exit.void));
        })
        .then((exit) => {
          if (Exit.isFailure(exit)) failures.push(...causeErrors(exit.cause));
        })
        .then(() => runtime.dispose())
        .catch(record)
        .then(() => {
          if (failures.length === 1) return Promise.reject(failures[0]);
          if (failures.length > 1)
            return Promise.reject(new AggregateError(failures, "Stack client close failed"));
        });
      return clientClosePromise;
    },
  };
};

/** Runs a scoped acquisition whose handles stay usable until the returned client closes. */
export const acquire = <A, E>(
  effect: Effect.Effect<A, E, ClientServices | Scope.Scope>,
  options?: CallOptions,
): Promise<{ readonly value: A; readonly client: Client }> => {
  const runtime = ManagedRuntime.make(clientLayer);
  const scope = runtime.runSync(Scope.make());
  const client = makeClient(runtime, scope);
  return runtime.runPromise(effect.pipe(Scope.provide(scope)), options).then(
    (value) => ({ value, client }),
    (error: unknown) =>
      client.close().then(
        () => Promise.reject(error),
        (closeError: unknown) =>
          Promise.reject(
            new AggregateError([error, closeError], "Stack acquisition and its cleanup failed"),
          ),
      ),
  );
};

/** Runs one unscoped operation with the client services. */
export const runOnce = <A, E>(
  effect: Effect.Effect<A, E, ClientServices>,
  options?: CallOptions,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(clientLayer)), options);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFunction = (value: unknown): value is (...args: ReadonlyArray<unknown>) => unknown =>
  typeof value === "function";
// Handle operations and streams need no services and fail with `StackError`.
const isOperation = (value: unknown): value is Effect.Effect<unknown, StackError> =>
  Effect.isEffect(value);
const isStream = (value: unknown): value is Stream.Stream<unknown, StackError> =>
  Stream.isStream(value);
/** No Effect operation takes a signal-only object, so one in last position is call options. */
const isCallOptions = (value: unknown): value is CallOptions =>
  isRecord(value) && Object.keys(value).every((key) => key === "signal");

/** Adapts the operations of an Effect handle; their results pass through as data. */
const makeAdapter = (client: Client) => {
  const call = (result: unknown, options: CallOptions | undefined) =>
    isOperation(result) ? client.run(result, options) : result;
  function promised<T>(value: T): Promised<T>;
  function promised(value: unknown): unknown {
    if (isStream(value)) return () => client.iterable(value);
    if (isOperation(value)) return (options?: CallOptions) => call(value, options);
    if (isFunction(value))
      return (...args: ReadonlyArray<unknown>) => {
        const last = args.at(-1);
        return isCallOptions(last)
          ? call(value(...args.slice(0, -1)), last)
          : call(value(...args), undefined);
      };
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, promised(item)]));
    return value;
  }
  return promised;
};

const creationJson = Schema.toCodecJson(CreationSchema);
const decodeCreation = (operation: string, creation: unknown) =>
  Schema.decodeUnknownEffect(creationJson)(creation).pipe(
    Effect.mapError((cause) => new StackError({ operation, message: cause.message })),
  );
const decodeCreations = (operation: string, creations: ReadonlyArray<unknown>) =>
  Effect.forEach(creations, (creation) => decodeCreation(operation, creation));
const sinkError = (cause: unknown) =>
  new StackError({
    operation: "tool-stream",
    message: failureMessage(cause),
  });
const sink = (write: (bytes: Uint8Array) => void | Promise<void>) => (bytes: Uint8Array) =>
  Effect.tryPromise({ try: () => Promise.resolve(write(bytes)), catch: sinkError });

/** Builds the Promise forms of a client's stack and service handles. */
export const stackAdapter = (client: Client) => {
  const promised = makeAdapter(client);
  function instance<K extends Kind>(service: StackEffect.ServiceInstances[K]): ServiceInstances[K];
  function instance(service: {
    readonly service: Kind;
    readonly restart: (input?: StackEffect.ServiceCreationInput) => Effect.Effect<void, StackError>;
  }): unknown {
    return {
      ...promised(service),
      restart: (input?: { readonly config: unknown }, options?: CallOptions) =>
        client.run(
          input === undefined
            ? service.restart()
            : decodeCreation(
                "restart",
                "service" in input ? input : { service: service.service, config: input.config },
              ).pipe(
                Effect.flatMap((creation) =>
                  creation.service === service.service
                    ? service.restart(creation)
                    : Effect.fail(
                        new StackError({
                          operation: "restart",
                          message: "Service kind cannot change",
                        }),
                      ),
                ),
              ),
          options,
        ),
    };
  }
  function services<K extends Kind>(handles: {
    readonly [P in K]: StackEffect.ServiceInstances[P];
  }): { readonly [P in K]: ServiceInstances[P] };
  function services(
    handles: Readonly<Record<string, StackEffect.ServiceInstances[Kind]>>,
  ): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
      Object.entries(handles).map(([kind, handle]) => [kind, instance(handle)]),
    );
  }
  const stack = (handle: StackEffect.Stack): Stack => {
    const derived = promised(handle);
    const instances = (handles: ReadonlyArray<StackEffect.ServiceInstances[Kind]>) =>
      handles.map((service) => instance(service));
    function create<Input extends ServiceCreationInput>(
      creation: Input,
      options?: CallOptions,
    ): Promise<ServiceInstances[Input["service"]]>;
    function create(creation: ServiceCreationInput, options?: CallOptions): Promise<unknown> {
      return client.run(
        decodeCreation("createService", creation).pipe(
          Effect.flatMap(handle.services.create),
          Effect.map((service) => instance(service)),
        ),
        options,
      );
    }
    return {
      ...derived,
      services: {
        create,
        get: (id, options) =>
          client.run(
            Effect.map(handle.services.get(id), (service) => instance(service)),
            options,
          ),
        list: (options) => client.run(Effect.map(handle.services.list, instances), options),
      },
      composition: {
        ...derived.composition,
        supabase: (creations, compositionOptions, options) =>
          client.run(
            decodeCreations("supabaseComposition", creations).pipe(
              Effect.flatMap((decoded) => handle.composition.supabase(decoded, compositionOptions)),
              Effect.map(instances),
            ),
            options,
          ),
        plan: (creations, options) =>
          client.run(
            decodeCreations("plan", creations).pipe(Effect.flatMap(handle.composition.plan)),
            options,
          ),
      },
      tools: {
        ...derived.tools,
        run: (tool, toolOptions, options) =>
          client.run(
            handle.tools.run(tool, {
              args: toolOptions.args,
              env: toolOptions.env,
              pgProve: toolOptions.pgProve,
              ...(toolOptions.stdin === undefined
                ? {}
                : { stdin: Stream.fromAsyncIterable(toolOptions.stdin, sinkError) }),
              stdout: sink(toolOptions.stdout),
              stderr: sink(toolOptions.stderr),
            }),
            options,
          ),
      },
      close: client.close,
    };
  };
  return { stack, services };
};

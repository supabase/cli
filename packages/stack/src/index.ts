import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import * as StackEffect from "./effect.ts";
import { StackError } from "./Rpc.ts";
import {
  ServiceCreation as CreationSchema,
  type ServiceCreation as EffectCreation,
} from "./services/Catalog.ts";
import type { PostgresTool } from "./Tools.ts";

export { postgres } from "./Tools.ts";
export { StackError } from "./Rpc.ts";
type DatabaseCreation = Extract<EffectCreation, { service: "database" }>;
/** Plain configuration accepted by non-Effect callers. */
export type ServiceCreation =
  | Exclude<EffectCreation, DatabaseCreation>
  | (Omit<DatabaseCreation, "config"> & {
      readonly config: Omit<DatabaseCreation["config"], "databasePassword" | "jwtSecret"> & {
        readonly databasePassword: string;
        readonly jwtSecret: string;
      };
    });
const creationJson = Schema.toCodecJson(CreationSchema);
const decodeCreation = (creation: ServiceCreation) =>
  Schema.decodeEffect(creationJson)(creation).pipe(
    Effect.mapError((cause) => new StackError({ operation: "config", message: cause.message })),
  );
export type { CompositionConfig } from "./Orchestrator.ts";
export type { Observation } from "./Rpc.ts";
export type { DatabaseSnapshot } from "./services/DatabaseSnapshot.ts";
export type { PgProveOptions } from "./effect.ts";
export type { SupabaseCompositionOptions } from "./effect.ts";
export type { CreateOptions, OpenOptions, StackLocations } from "./effect.ts";

const clientLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
type Runtime = ReturnType<typeof makeRuntime>;
const makeRuntime = () => ManagedRuntime.make(clientLayer);
type Kind = ServiceCreation["service"];
/** Optional cancellation ends the caller's wait, or its attached tool job. */
export interface CallOptions {
  readonly signal?: AbortSignal;
}
export type CompositionSupabaseOptions = StackEffect.SupabaseCompositionOptions & CallOptions;
/** An individual service; closing the client does not stop this process. */
export interface ServiceInstance<K extends Kind = Kind> {
  readonly id: string;
  readonly service: K;
  readonly start: (options?: CallOptions) => Promise<void>;
  readonly ready: (options?: CallOptions) => Promise<void>;
  readonly stop: (options?: CallOptions) => Promise<void>;
  readonly restart: (
    input?: Pick<Extract<ServiceCreation, { service: K }>, "config">,
    options?: CallOptions,
  ) => Promise<void>;
  readonly destroy: (options?: CallOptions) => Promise<void>;
  readonly prepare: (options?: CallOptions) => Promise<void>;
  readonly status: (options?: CallOptions) => Promise<StackEffect.Observation>;
  readonly followStatus: () => AsyncIterable<StackEffect.Observation>;
  readonly logs: () => AsyncIterable<{
    readonly stream: "stdout" | "stderr";
    readonly bytes: Uint8Array;
  }>;
  readonly credentials: (
    options?: CallOptions & { readonly from?: "host" | "runtime" },
  ) => Promise<Readonly<Record<string, string>>>;
}
/** Database storage operations require a stopped instance with wake disabled. */
export interface DatabaseInstance extends ServiceInstance<"database"> {
  readonly exportSnapshot: (
    destination: string,
    options?: CallOptions,
  ) => Promise<import("./services/DatabaseSnapshot.ts").DatabaseSnapshot>;
  readonly restoreSnapshot: (
    source: string,
    options?: CallOptions,
  ) => Promise<import("./services/DatabaseSnapshot.ts").DatabaseSnapshot>;
  /** Removes database-owned data while preserving the instance registration. */
  readonly resetData: (options?: CallOptions) => Promise<void>;
}
/** Creation preserves the selected service's available operations. */
export type ServiceInstances = {
  [K in Kind]: K extends "database" ? DatabaseInstance : ServiceInstance<K>;
};
type AnyInstance = ServiceInstances[Kind];
/** Streaming inputs and awaited output sinks for an attached finite tool. */
export interface ToolOptions extends CallOptions {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly pgProve?: StackEffect.PgProveOptions;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => void | Promise<void>;
  readonly stderr: (bytes: Uint8Array) => void | Promise<void>;
}

const adapt = (handle: StackEffect.Stack, runtime: Runtime) => {
  const run = <A, E>(effect: Effect.Effect<A, E>, options?: CallOptions) =>
    runtime.runPromise(effect, options);
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
      return {
        next: (value?: unknown) =>
          iterator.next(value).then(
            (result) => {
              if (result.done) {
                activeIterators.delete(dispose);
              }
              return result;
            },
            (error) => {
              activeIterators.delete(dispose);
              return Promise.reject(error);
            },
          ),
        return: close,
        ...(iteratorThrow === undefined
          ? {}
          : {
              throw: (error?: unknown) =>
                iteratorThrow(error).then(
                  (result) => {
                    if (result.done) {
                      activeIterators.delete(dispose);
                    }
                    return result;
                  },
                  (failure) => {
                    activeIterators.delete(dispose);
                    return Promise.reject(failure);
                  },
                ),
            }),
      };
    },
  });
  const common = <K extends Kind>(service: StackEffect.ServiceInstance<K>): ServiceInstance<K> => ({
    id: service.id,
    service: service.service,
    start: (options) => run(service.start, options),
    ready: (options) => run(service.ready, options),
    stop: (options) => run(service.stop, options),
    restart: (input, options) =>
      run(
        input === undefined
          ? service.restart()
          : Schema.decodeUnknownEffect(creationJson)({
              service: service.service,
              config: input.config,
            }).pipe(
              Effect.mapError(
                (cause) => new StackError({ operation: "restart", message: cause.message }),
              ),
              Effect.flatMap((decoded) => {
                const matchesKind = (
                  candidate: EffectCreation,
                ): candidate is EffectCreation &
                  Pick<Extract<EffectCreation, { service: K }>, "config"> =>
                  candidate.service === service.service;
                return matchesKind(decoded)
                  ? service.restart(decoded)
                  : Effect.fail(
                      new StackError({
                        operation: "restart",
                        message: "Service kind cannot change",
                      }),
                    );
              }),
            ),
        options,
      ),
    destroy: (options) => run(service.destroy, options),
    prepare: (options) => run(service.prepare, options),
    status: (options) => run(service.status, options),
    followStatus: () => iterable(service.followStatus),
    logs: () => iterable(service.logs),
    credentials: (options) => run(service.credentials(options), options),
  });
  function instance<K extends Kind>(service: StackEffect.ServiceInstances[K]): ServiceInstances[K];
  function instance(service: StackEffect.ServiceInstances[Kind]): AnyInstance {
    switch (service.service) {
      case "database":
        return {
          ...common(service),
          exportSnapshot: (destination, options) =>
            run(service.exportSnapshot(destination), options),
          restoreSnapshot: (source, options) => run(service.restoreSnapshot(source), options),
          resetData: (options) => run(service.resetData, options),
        };
      case "rest":
        return common(service);
      case "auth":
        return common(service);
      case "realtime":
        return common(service);
      case "storage":
        return common(service);
      case "imgproxy":
        return common(service);
      case "functions":
        return common(service);
      case "studio":
        return common(service);
      case "pgmeta":
        return common(service);
      case "mail":
        return common(service);
      case "analytics":
        return common(service);
      case "vector":
        return common(service);
      case "pooler":
        return common(service);
    }
  }
  function create<Input extends ServiceCreation>(
    creation: Input,
    options?: CallOptions,
  ): Promise<ServiceInstances[Input["service"]]>;
  function create(creation: ServiceCreation, options?: CallOptions): Promise<AnyInstance> {
    return run(
      decodeCreation(creation).pipe(Effect.flatMap(handle.services.create), Effect.map(instance)),
      options,
    );
  }
  const sinkError = (cause: unknown) =>
    new StackError({
      operation: "tool-stream",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  return {
    id: handle.id,
    services: {
      create,
      get: (id: string, options?: CallOptions) =>
        run(handle.services.get(id).pipe(Effect.map(instance)), options),
      list: (options?: CallOptions) =>
        run(handle.services.list.pipe(Effect.map((services) => services.map(instance))), options),
    },
    composition: {
      supabase: (services: ReadonlyArray<ServiceCreation>, options?: CompositionSupabaseOptions) =>
        run(
          Effect.forEach(services, decodeCreation).pipe(
            Effect.flatMap((decoded) => handle.composition.supabase(decoded, options)),
            Effect.map((instances) => instances.map(instance)),
          ),
          options,
        ),
      configure: (config: StackEffect.CompositionConfig, options?: CallOptions) =>
        run(handle.composition.configure(config), options),
      describe: (options?: CallOptions) => run(handle.composition.describe, options),
      start: (options?: CallOptions) => run(handle.composition.start, options),
      stop: (options?: CallOptions) => run(handle.composition.stop, options),
      restart: (options?: CallOptions) => run(handle.composition.restart, options),
    },
    stop: (options?: CallOptions) => run(handle.stop, options),
    destroy: (options?: CallOptions) => run(handle.destroy, options),
    close: () => {
      if (clientClosePromise !== undefined) return clientClosePromise;
      clientClosePromise = Promise.allSettled(
        [...activeIterators].map((dispose) => dispose()),
      ).then(() => runtime.dispose());
      return clientClosePromise;
    },
    tools: {
      run: (tool: PostgresTool, options: ToolOptions) =>
        run(
          handle.tools.run(tool, {
            args: options.args,
            env: options.env,
            pgProve: options.pgProve,
            ...(options.stdin === undefined
              ? {}
              : { stdin: Stream.fromAsyncIterable(options.stdin, sinkError) }),
            stdout: (bytes) =>
              Effect.tryPromise({
                try: () => Promise.resolve(options.stdout(bytes)),
                catch: sinkError,
              }),
            stderr: (bytes) =>
              Effect.tryPromise({
                try: () => Promise.resolve(options.stderr(bytes)),
                catch: sinkError,
              }),
          }),
          options,
        ),
    },
  };
};
/** A Promise client whose close operation leaves the detached owner running. */
export type Stack = ReturnType<typeof adapt>;

const acquire = (
  effect: ReturnType<typeof StackEffect.create>,
  options?: CallOptions,
): Promise<Stack> => {
  const runtime = makeRuntime();
  return runtime.runPromise(effect, options).then(
    (handle) => adapt(handle, runtime),
    (error: unknown) => runtime.dispose().then(() => Promise.reject(error)),
  );
};
/** Registers a new stack identity. */
export const create = (
  options: StackEffect.CreateOptions,
  callOptions?: CallOptions,
): Promise<Stack> => acquire(StackEffect.create(options), callOptions);
/** Opens an existing stack without launching its services. */
export const open = (options: StackEffect.OpenOptions, callOptions?: CallOptions): Promise<Stack> =>
  acquire(StackEffect.open(options), callOptions);
/** Discovers saved stacks and separately reports their live-owner availability. */
export const discover = (options: Pick<StackEffect.StackLocations, "stateRoot">) =>
  Effect.runPromise(StackEffect.discover(options).pipe(Effect.provide(clientLayer)));

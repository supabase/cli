import { Crypto, Deferred, Effect, Fiber, Layer, Match, Ref, Scope, Schema, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { connectHost, launchHost, waitForOwnerExit } from "./HostProcess.ts";
import type { SupabaseCompositionOptions } from "./composition/Supabase.ts";
import { deriveStackId, resolveStackIdentity } from "./identity/Identity.ts";
import * as State from "./State.ts";
import type { SavedStack } from "./State.ts";
import {
  StackError,
  StackErrorSchema,
  StackRpc,
  type Definition,
  type Observation,
} from "./Rpc.ts";
import { ServiceCreation } from "./services/Catalog.ts";
import type { DatabaseSnapshot } from "./services/DatabaseSnapshot.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { PgProveOptions, PostgresTool } from "./Tools.ts";

export { postgres } from "./Tools.ts";
export { StackError } from "./Rpc.ts";
export type { ServiceCreation } from "./services/Catalog.ts";
export type { CompositionConfig } from "./Orchestrator.ts";
export type { SupabaseCompositionOptions } from "./composition/Supabase.ts";
export type { Observation } from "./Rpc.ts";
export type { DatabaseSnapshot } from "./services/DatabaseSnapshot.ts";
export type { PgProveOptions } from "./Tools.ts";

const stateFor = (root: string) => State.Service.pipe(Effect.provide(State.layer({ root })));

/** Storage locations shared by clients and the detached stack owner. */
export interface StackLocations {
  readonly stateRoot: string;
  readonly cacheRoot: string;
}
/** Registers an isolated stack identity without starting service processes. */
export interface CreateOptions extends StackLocations {
  readonly projectRoot: string;
  readonly name?: string;
  readonly runtime: "native" | "docker" | "podman";
}
/** Opens a previously registered stack. */
export interface OpenOptions extends StackLocations {
  readonly id: string;
}

const failure = (operation: string, cause: unknown): StackError =>
  Schema.is(StackErrorSchema)(cause)
    ? new StackError(cause)
    : new StackError({
        operation,
        message: Schema.is(RpcClientError)(cause)
          ? `Owner response unavailable; the request outcome is uncertain: ${cause.message}`
          : cause instanceof Error
            ? cause.message
            : String(cause),
      });

type Kind = ServiceCreation["service"];
/** An individually identified service controlled through the owner. */
export interface ServiceInstance<K extends Kind = Kind> {
  readonly id: string;
  readonly service: K;
  readonly start: Effect.Effect<void, StackError>;
  readonly ready: Effect.Effect<void, StackError>;
  readonly stop: Effect.Effect<void, StackError>;
  readonly restart: (
    input?: Pick<Extract<ServiceCreation, { service: K }>, "config">,
  ) => Effect.Effect<void, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  readonly prepare: Effect.Effect<void, StackError>;
  readonly status: Effect.Effect<Observation, StackError>;
  readonly followStatus: Stream.Stream<Observation, StackError>;
  readonly logs: Stream.Stream<
    { readonly stream: "stdout" | "stderr"; readonly bytes: Uint8Array },
    StackError
  >;
  readonly credentials: (options?: {
    readonly from?: "host" | "runtime";
  }) => Effect.Effect<Readonly<Record<string, string>>, StackError>;
}
/** A database instance with stopped-data snapshot operations. */
export interface DatabaseInstance extends ServiceInstance<"database"> {
  readonly exportSnapshot: (destination: string) => Effect.Effect<DatabaseSnapshot, StackError>;
  readonly restoreSnapshot: (source: string) => Effect.Effect<DatabaseSnapshot, StackError>;
  /** Removes database-owned data while preserving the instance registration. */
  readonly resetData: Effect.Effect<void, StackError>;
}
/** Maps creation discriminators to their supported instance operations. */
export type ServiceInstances = {
  [K in Kind]: K extends "database" ? DatabaseInstance : ServiceInstance<K>;
};
type AnyInstance = ServiceInstances[Kind];
/** An attached finite command with backpressured byte streams. */
export interface ToolOptions<E, R> {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly pgProve?: PgProveOptions;
  readonly stdin?: Stream.Stream<Uint8Array, E, R>;
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
}
/** A client handle; its lifetime does not own service processes. */
export interface Stack {
  readonly id: string;
  readonly services: {
    readonly create: <Input extends ServiceCreation>(
      creation: Input,
    ) => Effect.Effect<ServiceInstances[Input["service"]], StackError>;
    readonly get: (id: string) => Effect.Effect<AnyInstance, StackError>;
    readonly list: Effect.Effect<ReadonlyArray<AnyInstance>, StackError>;
  };
  readonly composition: {
    readonly supabase: (
      services: ReadonlyArray<ServiceCreation>,
      options?: SupabaseCompositionOptions,
    ) => Effect.Effect<ReadonlyArray<AnyInstance>, StackError>;
    readonly configure: (config: Orchestrator.CompositionConfig) => Effect.Effect<void, StackError>;
    readonly describe: Effect.Effect<Orchestrator.CompositionConfig, StackError>;
    readonly start: Effect.Effect<ReadonlyArray<Observation>, StackError>;
    readonly stop: Effect.Effect<ReadonlyArray<Observation>, StackError>;
    readonly restart: Effect.Effect<ReadonlyArray<Observation>, StackError>;
  };
  readonly stop: Effect.Effect<void, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  readonly tools: {
    readonly run: <E, R>(
      tool: PostgresTool,
      options: ToolOptions<E, R>,
    ) => Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | StackError, R>;
  };
}

type Client = Effect.Success<ReturnType<typeof clientFor>>;
const clientFor = (port: number) =>
  RpcClient.make(StackRpc).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/rpc` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ),
  );

const makeHandle = Effect.fn("Stack.makeHandle")(function* (
  state: State.Interface,
  saved: SavedStack,
  locations: StackLocations,
) {
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const endpointFor = (live: boolean) =>
    (live
      ? launchHost(state, { ...locations, stackId: saved.id })
      : connectHost(state, saved.id)
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const client = (live: boolean) =>
    Effect.gen(function* () {
      const endpoint = yield* endpointFor(live);
      return yield* clientFor(endpoint.port);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const call = <A, E, R>(
    operation: string,
    run: (rpc: Client) => Effect.Effect<A, E, R>,
    live = true,
  ) =>
    Effect.scoped(Effect.flatMap(client(live), run)).pipe(
      Effect.mapError((cause) => failure(operation, cause)),
    );
  const stream = <A, E>(operation: string, run: (rpc: Client) => Stream.Stream<A, E>) =>
    Stream.unwrap(Effect.map(client(false), run)).pipe(
      Stream.mapError((cause) => failure(operation, cause)),
    );
  const shutdown = Effect.fn("Stack.shutdown")(function* (destroy: boolean) {
    const operation = destroy ? "destroy" : "shutdown";
    const endpoint = yield* Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* endpointFor(destroy);
        yield* clientFor(endpoint.port).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.flatMap((rpc) => rpc.shutdown({ destroy })),
        );
        return endpoint;
      }),
    ).pipe(Effect.mapError((cause) => failure(operation, cause)));
    yield* waitForOwnerExit(endpoint.pid).pipe(
      Effect.mapError((cause) => failure("shutdown-exit", cause)),
    );
  });

  const common = <K extends Kind>(id: string, service: K): ServiceInstance<K> => ({
    id,
    service,
    start: call("start", (rpc) => rpc.startService({ id })),
    ready: call("ready", (rpc) => rpc.readyService({ id }), false),
    stop: call("stop", (rpc) => rpc.stopService({ id })),
    restart: (input) =>
      input === undefined
        ? call("restart", (rpc) => rpc.restartService({ id }))
        : Schema.decodeUnknownEffect(ServiceCreation)({ service, config: input.config }).pipe(
            Effect.mapError((cause) => failure("restart", cause)),
            Effect.flatMap((creation) =>
              call("restart", (rpc) => rpc.restartService({ id, config: creation })),
            ),
          ),
    destroy: call("destroy", (rpc) => rpc.destroyService({ id })),
    prepare: call("prepare", (rpc) => rpc.prepareService({ id })),
    status: call("status", (rpc) => rpc.status({ id }), false),
    followStatus: stream("followStatus", (rpc) => rpc.followStatus({ id })),
    logs: stream("logs", (rpc) => rpc.logs({ id })),
    credentials: (options) =>
      call("credentials", (rpc) => rpc.credentials({ id, from: options?.from ?? "host" })),
  });
  function instance<Input extends ServiceCreation>(definition: {
    id: string;
    creation: Input;
  }): ServiceInstances[Input["service"]];
  function instance(definition: Definition): AnyInstance {
    const { id, creation } = definition;
    switch (creation.service) {
      case "database":
        return {
          ...common(id, "database"),
          exportSnapshot: (destination) =>
            call("exportSnapshot", (rpc) => rpc.exportSnapshot({ id, destination })),
          restoreSnapshot: (source) =>
            call("restoreSnapshot", (rpc) => rpc.restoreSnapshot({ id, source })),
          resetData: call("resetData", (rpc) => rpc.resetData({ id })),
        };
      case "rest":
        return common(id, "rest");
      case "auth":
        return common(id, "auth");
      case "realtime":
        return common(id, "realtime");
      case "storage":
        return common(id, "storage");
      case "imgproxy":
        return common(id, "imgproxy");
      case "functions":
        return common(id, "functions");
      case "studio":
        return common(id, "studio");
      case "pgmeta":
        return common(id, "pgmeta");
      case "mail":
        return common(id, "mail");
      case "analytics":
        return common(id, "analytics");
      case "vector":
        return common(id, "vector");
      case "pooler":
        return common(id, "pooler");
    }
  }
  function create<Input extends ServiceCreation>(
    creation: Input,
  ): Effect.Effect<ServiceInstances[Input["service"]], StackError>;
  function create(creation: ServiceCreation): Effect.Effect<AnyInstance, StackError> {
    return call("createService", (rpc) => rpc.createService(creation)).pipe(Effect.map(instance));
  }
  const run = Effect.fn("Stack.runTool")(function* <E, R>(
    tool: PostgresTool,
    options: ToolOptions<E, R>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* client(true).pipe(Effect.mapError((cause) => failure("tool", cause)));
        const attachmentId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => failure("tool", cause)),
        );
        const scope = yield* Scope.Scope;
        const inputFailure = yield* Deferred.make<never, E | StackError>();
        const result = yield* Ref.make<{ jobId: string; exitCode: number } | undefined>(undefined);
        const sender = yield* Ref.make<Fiber.Fiber<void, E | StackError> | undefined>(undefined);
        yield* rpc
          .runTool({
            attachmentId,
            tool,
            args: options.args ?? [],
            env: options.env ?? {},
            ...(options.pgProve === undefined ? {} : { pgProve: options.pgProve }),
            stdin: options.stdin !== undefined,
          })
          .pipe(
            Stream.mapError((cause) => failure("tool", cause)),
            Stream.runForEach((event): Effect.Effect<void, E | StackError, R> =>
              Match.valueTags(event, {
                Attached: () =>
                  options.stdin === undefined
                    ? Effect.void
                    : options.stdin.pipe(
                        Stream.runForEach((bytes) =>
                          Effect.forEach(
                            Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, index) =>
                              bytes.subarray(index * 65536, (index + 1) * 65536),
                            ),
                            (chunk) =>
                              rpc
                                .toolInput({ attachmentId, bytes: chunk })
                                .pipe(Effect.mapError((cause) => failure("stdin", cause))),
                            { discard: true },
                          ),
                        ),
                        Effect.andThen(
                          rpc
                            .toolInput({ attachmentId, bytes: null })
                            .pipe(Effect.mapError((cause) => failure("stdin", cause))),
                        ),
                        Effect.catchIf(
                          (cause) =>
                            Schema.is(StackErrorSchema)(cause) &&
                            cause.operation === "tool-input-closed",
                          () => Effect.void,
                        ),
                        Effect.tapCause((cause) => Deferred.failCause(inputFailure, cause)),
                        Effect.forkIn(scope),
                        Effect.flatMap((fiber) => Ref.set(sender, fiber)),
                      ),
                Stdout: (output) => options.stdout(output.bytes),
                Stderr: (output) => options.stderr(output.bytes),
                Completed: (completed) =>
                  Ref.set(result, { jobId: completed.jobId, exitCode: completed.exitCode }),
              }),
            ),
            Effect.raceFirst(Deferred.await(inputFailure)),
          );
        const input = yield* Ref.get(sender);
        if (input !== undefined) yield* Fiber.interrupt(input);
        const completed = yield* Ref.get(result);
        if (completed === undefined)
          return yield* failure("tool", "Tool attachment ended without an exit result");
        return completed;
      }),
    );
  });
  const savedDefinition = Effect.gen(function* () {
    const current = yield* state.read(saved.id);
    if (current === undefined) return yield* failure("definition", "Stack does not exist");
    return current;
  }).pipe(Effect.mapError((cause) => failure("definition", cause)));
  const definitions = savedDefinition.pipe(
    Effect.flatMap((current) =>
      Effect.forEach(current.instances, (entry) =>
        Schema.decodeUnknownEffect(Schema.toCodecJson(ServiceCreation))(entry.creation).pipe(
          Effect.map((creation) => ({ id: entry.id, creation })),
          Effect.mapError((cause) => failure("definition", cause)),
        ),
      ),
    ),
  );
  return {
    id: saved.id,
    services: {
      create,
      get: (id: string) =>
        definitions.pipe(
          Effect.flatMap((entries) => {
            const definition = entries.find((entry) => entry.id === id);
            return definition === undefined
              ? Effect.fail(failure("getService", `Unknown service ${id}`))
              : Effect.succeed(instance(definition));
          }),
        ),
      list: definitions.pipe(Effect.map((entries) => entries.map(instance))),
    },
    composition: {
      supabase: (services: ReadonlyArray<ServiceCreation>, options?: SupabaseCompositionOptions) =>
        call("supabaseComposition", (rpc) =>
          rpc.supabaseComposition({
            services,
            ...(options?.reuseIds === undefined ? {} : { reuseIds: options.reuseIds }),
          }),
        ).pipe(Effect.map((definitions) => definitions.map(instance))),
      configure: (config: Orchestrator.CompositionConfig) =>
        call("configureComposition", (rpc) => rpc.configureComposition(config)),
      describe: savedDefinition.pipe(
        Effect.flatMap((current) =>
          Schema.decodeUnknownEffect(Orchestrator.CompositionConfig)(current.composition),
        ),
        Effect.mapError((cause) => failure("getComposition", cause)),
      ),
      start: call("startComposition", (rpc) => rpc.startComposition()),
      stop: call("stopComposition", (rpc) => rpc.stopComposition()),
      restart: call("restartComposition", (rpc) => rpc.restartComposition()),
    },
    stop: shutdown(false),
    destroy: shutdown(true),
    tools: { run },
  } satisfies Stack;
});

/** Registers a stack; a matching existing identity must be opened explicitly. */
export const create = Effect.fn("Stack.create")(
  function* (options: CreateOptions) {
    const state = yield* stateFor(options.stateRoot);
    const identity = yield* resolveStackIdentity(options);
    const id = yield* deriveStackId(identity);
    const saved: SavedStack = {
      id,
      identity,
      runtime: options.runtime,
      instances: [],
      composition: { members: [], dependencies: [] },
      ports: [],
    };
    yield* state.withLock(
      Effect.gen(function* () {
        if ((yield* state.read(id)) !== undefined)
          return yield* failure("create", "Stack already exists; use open");
        yield* state.save(saved);
      }),
    );
    return yield* makeHandle(state, saved, options);
  },
  Effect.mapError((cause) => failure("create", cause)),
);

/** Opens saved definitions without starting or reconstructing live services. */
export const open = Effect.fn("Stack.open")(
  function* (options: OpenOptions) {
    const state = yield* stateFor(options.stateRoot);
    const saved = yield* state.read(options.id);
    if (saved === undefined) return yield* failure("open", "Stack does not exist");
    return yield* makeHandle(state, saved, options);
  },
  Effect.mapError((cause) => failure("open", cause)),
);

/** Lists saved resources separately from the availability of their live owners. */
export const discover = Effect.fn("Stack.discover")(
  function* (options: Pick<StackLocations, "stateRoot">) {
    const state = yield* stateFor(options.stateRoot);
    const saved = yield* state.list;
    return yield* Effect.forEach(saved, (definition) =>
      connectHost(state, definition.id).pipe(
        Effect.map((host) => ({ definition, host })),
        Effect.catchTag("HostProcessError", () => Effect.succeed({ definition, host: undefined })),
      ),
    );
  },
  Effect.mapError((cause) => failure("discover", cause)),
);

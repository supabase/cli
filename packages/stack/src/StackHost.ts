import { NodeHttpServerRequest, NodeHttpClient, NodeServices } from "@effect/platform-node";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
  Path,
} from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { acquireHost, HostEndpoint } from "./HostProcess.ts";
import * as Owner from "./Owner.ts";
import { OwnerError } from "./Owner.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { StackError, StackRpc } from "./Rpc.ts";
import * as State from "./State.ts";
import { makeToolAttachments, type ToolAttachmentPayload } from "./host/ToolAttachments.ts";
import * as ToolRunner from "./host/ToolRunner.ts";
import type { CatalogLog } from "./services/Catalog.ts";

export interface StackHostOptions {
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly stackId: string;
  readonly onReady?: (endpoint: HostEndpoint) => Effect.Effect<void, StackHostError>;
}

export class StackHostError extends Data.TaggedError("StackHostError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hostError = (operation: string, cause: unknown) =>
  new StackHostError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const stackError = (operation: string, cause: unknown): StackError => {
  if (cause instanceof StackError) return cause;
  const orchestration =
    cause instanceof Orchestrator.OrchestratorError
      ? cause
      : cause instanceof OwnerError && cause.cause instanceof Orchestrator.OrchestratorError
        ? cause.cause
        : undefined;
  if (orchestration?.outcomes !== undefined) {
    return new StackError({
      operation,
      message: orchestration.message,
      outcomes: orchestration.outcomes.map(({ id, result }) => ({
        id,
        succeeded: Exit.isSuccess(result),
        ...(Exit.isFailure(result) ? { error: Cause.pretty(result.cause) } : {}),
      })),
    });
  }
  return new StackError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
};

const log = (value: CatalogLog) => ({ stream: value.stream, bytes: value.bytes });

const isOpen = (value: boolean): Effect.Effect<void, StackError> =>
  value
    ? Effect.void
    : Effect.fail(new StackError({ operation: "host", message: "Stack host is draining" }));

const requestSignal = () =>
  Effect.callback<"SIGTERM" | "SIGINT", never>((resume) => {
    const onTerm = () => resume(Effect.succeed("SIGTERM"));
    const onInt = () => resume(Effect.succeed("SIGINT"));
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);
    return Effect.sync(() => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    });
  });

const responseClosed = (response: ReturnType<typeof NodeHttpServerRequest.toServerResponse>) =>
  Effect.callback<void, never>((resume) => {
    if (response.writableEnded || response.destroyed) {
      resume(Effect.void);
      return Effect.void;
    }
    const done = () => resume(Effect.void);
    response.once("finish", done);
    response.once("close", done);
    return Effect.sync(() => {
      response.off("finish", done);
      response.off("close", done);
    });
  });

export interface StackHostRuntime {
  readonly endpoint: HostEndpoint;
  readonly serve: Effect.Effect<void, never, Scope.Scope>;
  readonly closeConnections: Effect.Effect<void>;
  readonly shutdown: (
    destroy: boolean,
    response?: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
  ) => Effect.Effect<void, StackError>;
  readonly exit: Deferred.Deferred<void>;
}

export const makeRuntime = Effect.fn("StackHost.makeRuntime")(
  (
    owner: Owner.Interface,
    endpoint: HostEndpoint,
    server: HttpServer.HttpServer["Service"],
    closeConnections: Effect.Effect<void>,
  ): Effect.Effect<StackHostRuntime, never, Scope.Scope | ToolRunner.Service> =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const runner = yield* ToolRunner.Service;
      const attachments = yield* makeToolAttachments({
        admit: owner.getServing.pipe(
          Effect.flatMap(isOpen),
          Effect.mapError((cause) => stackError("host", cause)),
        ),
        run: runner.run,
        toError: stackError,
      });
      const exit = yield* Deferred.make<void>();
      const gate = yield* Semaphore.make(1);
      const current = yield* Ref.make<
        { destroy: boolean; fiber: Fiber.Fiber<void, StackError> } | undefined
      >(undefined);
      const watchResponse = (
        response: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
        closed: Deferred.Deferred<void>,
      ) =>
        Effect.forkIn(
          responseClosed(response).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
          scope,
        );

      const shutdown = Effect.fn("StackHost.shutdown")(
        (destroy: boolean, response?: ReturnType<typeof NodeHttpServerRequest.toServerResponse>) =>
          Effect.gen(function* () {
            const fiber = yield* gate.withPermits(1)(
              Effect.uninterruptibleMask(() =>
                Effect.gen(function* () {
                  const existing = yield* Ref.get(current);
                  if (existing !== undefined) {
                    if (existing.destroy !== destroy)
                      return yield* new StackError({
                        operation: "shutdown",
                        message: "Shutdown mode is already selected",
                      });
                    return existing.fiber;
                  }
                  yield* owner.setDraining(true);
                  const responseClosedSignal =
                    response === undefined ? undefined : yield* Deferred.make<void>();
                  if (response !== undefined && responseClosedSignal !== undefined)
                    yield* watchResponse(response, responseClosedSignal);
                  const cleanup = Effect.gen(function* () {
                    yield* attachments.stopAll;
                    if (destroy) yield* runner.cleanup;
                    yield* destroy ? owner.namespace.destroy : owner.namespace.stop;
                    if (response !== undefined) {
                      if (responseClosedSignal === undefined) return;
                      yield* Effect.forkIn(
                        Deferred.await(responseClosedSignal).pipe(
                          Effect.andThen(closeConnections),
                          Effect.andThen(Deferred.succeed(exit, undefined)),
                        ),
                        scope,
                      );
                    } else {
                      yield* closeConnections;
                      yield* Deferred.succeed(exit, undefined);
                    }
                  }).pipe(
                    Effect.mapError((cause) => stackError("shutdown", cause)),
                    Effect.catchCause((cause) =>
                      owner.setDraining(false).pipe(
                        Effect.mapError((reset) => stackError("shutdown", reset)),
                        Effect.andThen(gate.withPermits(1)(Ref.set(current, undefined))),
                        Effect.andThen(Effect.failCause(cause)),
                      ),
                    ),
                  );
                  const fiber = yield* Effect.forkIn(cleanup, scope);
                  yield* Ref.set(current, { destroy, fiber });
                  return fiber;
                }),
              ),
            );
            yield* Fiber.join(fiber);
          }).pipe(Effect.mapError((cause) => stackError("shutdown", cause))),
      );
      const handlers = {
        createService: (creation: unknown) =>
          owner.services
            .create(creation)
            .pipe(Effect.mapError((cause) => stackError("createService", cause))),
        getService: ({ id }: { readonly id: string }) =>
          owner.services.get(id).pipe(Effect.mapError((cause) => stackError("getService", cause))),
        listServices: () =>
          owner.services.list.pipe(Effect.mapError((cause) => stackError("listServices", cause))),
        startService: ({ id }: { readonly id: string }) =>
          owner.core.start(id).pipe(Effect.mapError((cause) => stackError("startService", cause))),
        readyService: ({ id }: { readonly id: string }) =>
          owner.core.ready(id).pipe(Effect.mapError((cause) => stackError("readyService", cause))),
        stopService: ({ id }: { readonly id: string }) =>
          owner.core.stop(id).pipe(Effect.mapError((cause) => stackError("stopService", cause))),
        restartService: ({ id, config }: { readonly id: string; readonly config?: unknown }) =>
          owner.core
            .restart(id, config)
            .pipe(Effect.mapError((cause) => stackError("restartService", cause))),
        destroyService: ({ id }: { readonly id: string }) =>
          owner.core
            .destroy(id)
            .pipe(Effect.mapError((cause) => stackError("destroyService", cause))),
        prepareService: ({ id }: { readonly id: string }) =>
          owner.core
            .prepare(id)
            .pipe(Effect.mapError((cause) => stackError("prepareService", cause))),
        status: ({ id }: { readonly id: string }) =>
          owner.core.status(id).pipe(Effect.mapError((cause) => stackError("status", cause))),
        followStatus: ({ id }: { readonly id: string }) =>
          owner.core
            .followStatus(id)
            .pipe(Stream.mapError((cause) => stackError("followStatus", cause))),
        logs: ({ id }: { readonly id: string }) =>
          owner.core.logs(id).pipe(
            Stream.map(log),
            Stream.mapError((cause) => stackError("logs", cause)),
          ),
        credentials: ({ id, from }: { readonly id: string; readonly from: "host" | "runtime" }) =>
          owner
            .credentials(id, from)
            .pipe(Effect.mapError((cause) => stackError("credentials", cause))),
        exportSnapshot: ({
          id,
          destination,
        }: {
          readonly id: string;
          readonly destination: string;
        }) =>
          owner.snapshots
            .exportSnapshot(id, destination)
            .pipe(Effect.mapError((cause) => stackError("exportSnapshot", cause))),
        restoreSnapshot: ({ id, source }: { readonly id: string; readonly source: string }) =>
          owner.snapshots
            .restoreSnapshot(id, source)
            .pipe(Effect.mapError((cause) => stackError("restoreSnapshot", cause))),
        resetData: ({ id }: { readonly id: string }) =>
          owner.snapshots
            .resetData(id)
            .pipe(Effect.mapError((cause) => stackError("resetData", cause))),
        supabaseComposition: ({
          services,
          reuseIds,
        }: {
          readonly services: Parameters<Owner.Interface["composition"]["supabase"]>[0];
          readonly reuseIds?: NonNullable<
            Parameters<Owner.Interface["composition"]["supabase"]>[1]
          >["reuseIds"];
        }) =>
          owner.composition
            .supabase(services, { reuseIds })
            .pipe(Effect.mapError((cause) => stackError("supabaseComposition", cause))),
        configureComposition: (
          configuration: Parameters<Owner.Interface["composition"]["configure"]>[0],
        ) =>
          owner.composition
            .configure(configuration)
            .pipe(Effect.mapError((cause) => stackError("configureComposition", cause))),
        getComposition: () =>
          owner.composition.get.pipe(
            Effect.mapError((cause) => stackError("getComposition", cause)),
          ),
        startComposition: () =>
          owner.composition.start.pipe(
            Effect.mapError((cause) => stackError("startComposition", cause)),
          ),
        stopComposition: () =>
          owner.composition.stop.pipe(
            Effect.mapError((cause) => stackError("stopComposition", cause)),
          ),
        restartComposition: () =>
          owner.composition.restart.pipe(
            Effect.mapError((cause) => stackError("restartComposition", cause)),
          ),
        shutdown: ({ destroy }: { readonly destroy: boolean }) =>
          Effect.gen(function* () {
            const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
            yield* Option.match(request, {
              onNone: () =>
                Effect.fail(
                  new StackError({ operation: "shutdown", message: "Request context is missing" }),
                ),
              onSome: (value) => shutdown(destroy, NodeHttpServerRequest.toServerResponse(value)),
            });
          }).pipe(Effect.mapError((cause) => stackError("shutdown", cause))),
        runTool: (input: ToolAttachmentPayload) => attachments.run(input),
        toolInput: ({
          attachmentId,
          bytes,
        }: {
          readonly attachmentId: string;
          readonly bytes: Uint8Array | null;
        }) => attachments.input(attachmentId, true, bytes),
      };
      const rpc = yield* RpcServer.toHttpEffect(StackRpc, { streamBufferSize: 16 }).pipe(
        Effect.provide(Layer.merge(StackRpc.toLayer(handlers), RpcSerialization.layerNdjson)),
      );
      const application: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest.HttpServerRequest | Scope.Scope
      > = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === "GET" && request.url === "/identity") {
          return HttpServerResponse.jsonUnsafe(endpoint);
        }
        if (request.method === "POST" && request.url.startsWith("/rpc"))
          return yield* rpc.pipe(Effect.interruptible);
        return HttpServerResponse.empty({ status: 404 });
      });
      const serve: Effect.Effect<void, never, Scope.Scope> = server.serve(application);
      return { endpoint, serve, shutdown, closeConnections, exit };
    }),
);

export const runStackHost = Effect.fn("StackHost.run")(
  (options: StackHostOptions): Effect.Effect<void, StackHostError, never> =>
    Effect.scoped(
      Effect.gen(function* () {
        const signals = yield* Queue.bounded<"SIGTERM" | "SIGINT">(8);
        yield* Effect.forkScoped(
          Effect.forever(
            requestSignal().pipe(
              Effect.flatMap((signal) => Queue.offer(signals, signal).pipe(Effect.asVoid)),
            ),
          ),
        );
        const started = yield* Effect.gen(function* () {
          const stateContext = yield* Layer.build(State.layer({ root: options.stateRoot }));
          const state = Context.get(stateContext, State.Service);
          const path = yield* Path.Path;
          const saved = yield* state.read(options.stackId);
          if (saved === undefined) return yield* hostError("startup", "Stack is not registered");
          const acquired = yield* acquireHost(state, options.stackId);
          const services = yield* Layer.build(
            Layer.merge(
              Owner.layer({
                saved,
                root: path.join(options.stateRoot, saved.id, "data"),
                cacheRoot: options.cacheRoot,
              }),
              ToolRunner.layer({
                stackId: saved.id,
                root: path.join(options.stateRoot, saved.id, "data"),
                cacheRoot: options.cacheRoot,
                runtime: saved.runtime,
              }),
            ).pipe(Layer.provide(Layer.succeed(State.Service, state))),
          );
          const owner = Context.get(services, Owner.Service);
          const endpoint: HostEndpoint = {
            stackId: saved.id,
            identity: saved.identity,
            pid: process.pid,
            port: acquired.port,
          };
          const runtime = yield* makeRuntime(
            owner,
            endpoint,
            acquired.server,
            acquired.closeConnections,
          ).pipe(
            Effect.provideService(ToolRunner.Service, Context.get(services, ToolRunner.Service)),
          );
          yield* runtime.serve;
          yield* options.onReady?.(endpoint) ?? Effect.void;
          return runtime;
        }).pipe(
          Effect.raceFirst(
            Queue.take(signals).pipe(
              Effect.flatMap((signal) => hostError("startup", `Received ${signal} during startup`)),
            ),
          ),
        );
        while (true) {
          const event = yield* Deferred.await(started.exit).pipe(
            Effect.map(() => "done" as const),
            Effect.raceFirst(Queue.take(signals).pipe(Effect.map(() => "signal" as const))),
          );
          if (event === "done") break;
          const shutdownSucceeded = yield* started
            .shutdown(false)
            .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
          if (shutdownSucceeded) break;
        }
      }),
    ).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
      Effect.mapError((cause) =>
        cause instanceof StackHostError ? cause : hostError("host", cause),
      ),
    ),
);

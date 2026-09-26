import { NodeHttpServerRequest, NodeHttpClient, NodeServices } from "@effect/platform-node";
import {
  Context,
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Path,
} from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { acquireHost, HostEndpoint } from "./HostProcess.ts";
import * as Owner from "./Owner.ts";
import { StackError, stackError, StackRpc } from "./Rpc.ts";
import * as State from "./State.ts";
import { makeToolAttachments, type ToolAttachmentPayload } from "./host/ToolAttachments.ts";
import * as ToolRunner from "./host/ToolRunner.ts";

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
  readonly reason?: "runtime-unavailable";
}> {}

const hostError = (operation: string, cause: unknown, reason?: "runtime-unavailable") =>
  new StackHostError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
    ...(reason === undefined ? {} : { reason }),
  });

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
        admit: owner.getServing.pipe(Effect.flatMap(isOpen)),
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
                    if (existing.destroy && !destroy) return existing.fiber;
                    if (!existing.destroy && destroy)
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
                  let retiringAfterDestroyFailure = false;
                  const stopOwned = Effect.gen(function* () {
                    yield* attachments.stopAll;
                    yield* runner.cleanup;
                    yield* owner.namespace.stop;
                  });
                  const finish = Effect.gen(function* () {
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
                  });
                  const cleanup = Effect.gen(function* () {
                    if (!destroy) {
                      yield* stopOwned;
                      yield* finish;
                      return;
                    }
                    const destroyExit = yield* Effect.gen(function* () {
                      yield* attachments.stopAll;
                      yield* runner.cleanup;
                      yield* owner.namespace.destroy;
                    }).pipe(Effect.exit);
                    if (Exit.isSuccess(destroyExit)) {
                      yield* finish;
                      return;
                    }
                    const stopExit = yield* stopOwned.pipe(Effect.exit);
                    if (Exit.isFailure(stopExit)) {
                      const describeCause = (cause: Cause.Cause<unknown>) => {
                        const error = Option.match(Cause.findErrorOption(cause), {
                          onNone: () =>
                            new StackError({
                              operation: "shutdown",
                              message: Cause.pretty(cause),
                            }),
                          onSome: (value) => stackError("shutdown", value),
                        });
                        const failedOutcomes = error.outcomes
                          ?.filter(({ succeeded }) => !succeeded)
                          .map(({ id, error: reason }) => `${id}: ${reason ?? "failed"}`)
                          .join("; ");
                        return {
                          error,
                          message:
                            failedOutcomes === undefined || failedOutcomes.length === 0
                              ? error.message
                              : `${error.message} (${failedOutcomes})`,
                        };
                      };
                      const destroyFailure = describeCause(destroyExit.cause);
                      const stopFailure = describeCause(stopExit.cause);
                      const outcomes = [
                        ...(destroyFailure.error.outcomes ?? []),
                        ...(stopFailure.error.outcomes ?? []),
                      ];
                      return yield* new StackError({
                        operation: "shutdown",
                        message: `${destroyFailure.message}; fallback stop failed: ${stopFailure.message}`,
                        ...(outcomes.length === 0 ? {} : { outcomes }),
                      });
                    }
                    retiringAfterDestroyFailure = true;
                    yield* finish;
                    return yield* Effect.failCause(destroyExit.cause);
                  }).pipe(
                    Effect.mapError((cause) => stackError("shutdown", cause)),
                    Effect.catchCause((cause) =>
                      retiringAfterDestroyFailure
                        ? Effect.failCause(cause)
                        : owner
                            .setDraining(false)
                            .pipe(
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
      const handlers = StackRpc.of({
        ...owner.handlers,
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
      });
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
          const fs = yield* FileSystem.FileSystem;
          const saved = yield* state.read(options.stackId);
          if (saved === undefined) return yield* hostError("startup", "Stack is not registered");
          const acquired = yield* acquireHost(state, options.stackId);
          const dataRootPath = path.join(options.stateRoot, saved.id, "data");
          yield* fs.makeDirectory(dataRootPath, { recursive: true });
          const dataRoot = yield* fs.realPath(dataRootPath);
          yield* Owner.sweepContainers(saved, dataRoot).pipe(
            Effect.mapError((cause) =>
              hostError(
                "startup-cleanup",
                cause,
                cause.reason === "engine-unavailable" ? "runtime-unavailable" : undefined,
              ),
            ),
          );
          const services = yield* Layer.build(
            Layer.merge(
              Owner.layer({
                saved,
                root: dataRoot,
                cacheRoot: options.cacheRoot,
              }),
              ToolRunner.layer({
                stackId: saved.id,
                root: dataRoot,
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
          const shutdownSucceeded = yield* started.shutdown(false).pipe(
            Effect.tapCause((cause) => Effect.logError("Stack shutdown failed", cause)),
            Effect.matchCause({ onSuccess: () => true, onFailure: () => false }),
          );
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

import {
  NodeHttpClient,
  NodeHttpServer,
  NodeHttpServerRequest,
  NodeServices,
} from "@effect/platform-node";
import {
  Context,
  Cause,
  Crypto,
  Data,
  DateTime,
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
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";
import {
  currentRelease,
  authorizes,
  ShutdownRequest,
  type HostAccess,
  type HostEndpoint,
  type ShutdownFailure,
} from "./HostProcess.ts";
import { projectSegmentFor } from "./identity/Identity.ts";
import * as Owner from "./Owner.ts";
import {
  StackError,
  stackError,
  StackRpc,
  type EndpointPortChange,
  type RunCommandPayload,
} from "./Rpc.ts";
import { makeHostGateway } from "./runtime/Container.ts";
import * as State from "./State.ts";
import { sweepOrphans } from "./Sweep.ts";
import { makeCommandAttachments } from "./host/CommandAttachments.ts";
import * as CommandRunner from "./host/CommandRunner.ts";
import {
  prepareEndpointReplan,
  reportedEndpointChanges,
  restoreFailedEndpointReplan,
} from "./composition/EndpointReplan.ts";
import type { ServiceCreationInput } from "./services/Catalog.ts";

export interface StackHostOptions {
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly stackId: string;
  /** Registers this definition once the owner holds the lease; the stack must not exist. */
  readonly register?: State.SavedStack;
  /**
   * Re-plans changed endpoint ports against the saved state before the owner registers endpoint
   * namespaces from it, while this process alone holds the lease; the owner's own normal endpoint
   * binding then claims them.
   */
  readonly requestedCreations?: ReadonlyArray<ServiceCreationInput>;
  readonly release?: string;
  readonly onReady?: (access: HostAccess) => Effect.Effect<void, StackHostError>;
}

export class StackHostError extends Data.TaggedError("StackHostError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly reason?: "lease-held" | "exists" | "runtime-unavailable";
}> {}

const hostError = (operation: string, cause: unknown, reason?: "runtime-unavailable") =>
  new StackHostError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
    ...(reason === undefined ? {} : { reason }),
  });

/** Binds the owner's loopback control listener on an OS-assigned port. */
export const bindControl = Effect.fn("StackHost.bindControl")(function* () {
  let rawServer: Http.Server | undefined;
  const server = yield* NodeHttpServer.make(
    () => {
      rawServer = Http.createServer();
      return rawServer;
    },
    { host: "127.0.0.1", port: 0 },
  ).pipe(Effect.mapError((cause) => hostError("control", cause)));
  if (server.address._tag !== "TcpAddress")
    return yield* hostError("control", "Control listener has no TCP address");
  return {
    port: server.address.port,
    server,
    closeConnections: Effect.sync(() => {
      rawServer?.closeAllConnections();
      rawServer?.closeIdleConnections();
    }),
  };
});

const shutdownFailure = (cause: unknown): ShutdownFailure => {
  const failure = stackError("shutdown", cause);
  return {
    message: failure.message,
    ...(failure.outcomes === undefined ? {} : { outcomes: failure.outcomes }),
  };
};

const creatorGone = Effect.callback<void>((resume) => {
  const done = () => resume(Effect.void);
  process.stdin.once("end", done);
  process.stdin.once("close", done);
  process.stdin.once("error", done);
  process.stdin.resume();
  return Effect.sync(() => {
    process.stdin.off("end", done);
    process.stdin.off("close", done);
    process.stdin.off("error", done);
    process.stdin.pause();
  });
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
  readonly access: HostAccess;
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
    access: HostAccess,
    server: HttpServer.HttpServer["Service"],
    closeConnections: Effect.Effect<void>,
    startupEndpointChanges: ReadonlyArray<EndpointPortChange> = [],
  ): Effect.Effect<StackHostRuntime, never, Scope.Scope | CommandRunner.Service> =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const runner = yield* CommandRunner.Service;
      const attachments = yield* makeCommandAttachments({
        admit: owner.getServing.pipe(Effect.flatMap(isOpen)),
        run: (input) =>
          "stdin" in input
            ? runner.run({
                command: input.command,
                stdin: input.stdin,
                stdout: input.stdout,
                stderr: input.stderr,
              })
            : owner.getStackCredentials.pipe(
                Effect.mapError(
                  (cause) => new CommandRunner.CommandError({ message: cause.message, cause }),
                ),
                Effect.flatMap((credentials) =>
                  runner.run({
                    command: input.command,
                    credentials,
                    stdout: input.stdout,
                    stderr: input.stderr,
                  }),
                ),
              ),
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
        runCommand: (input: RunCommandPayload) => attachments.run(input),
        commandInput: ({
          attachmentId,
          bytes,
        }: {
          readonly attachmentId: string;
          readonly bytes: Uint8Array | null;
        }) => attachments.input(attachmentId, bytes),
        startupEndpointChanges: () => Effect.succeed(startupEndpointChanges),
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
        if (!authorizes(request.headers.authorization, access.secret))
          return HttpServerResponse.empty({ status: 401 });
        if (request.method === "GET" && request.url === "/identity") {
          return HttpServerResponse.jsonUnsafe(access.endpoint);
        }
        if (request.method === "POST" && request.url === "/shutdown") {
          const body = yield* HttpServerRequest.schemaBodyJson(ShutdownRequest).pipe(Effect.option);
          if (Option.isNone(body)) return HttpServerResponse.empty({ status: 400 });
          const result = yield* shutdown(
            body.value.destroy,
            NodeHttpServerRequest.toServerResponse(request),
          ).pipe(Effect.exit);
          return Exit.isSuccess(result)
            ? HttpServerResponse.empty({ status: 204 })
            : HttpServerResponse.jsonUnsafe(
                shutdownFailure(
                  Option.getOrElse(Cause.findErrorOption(result.cause), () =>
                    Cause.pretty(result.cause),
                  ),
                ),
                { status: 500 },
              );
        }
        if (request.method === "POST" && request.url.startsWith("/rpc"))
          return yield* rpc.pipe(Effect.interruptible);
        return HttpServerResponse.empty({ status: 404 });
      });
      const serve: Effect.Effect<void, never, Scope.Scope> = server.serve(application);

      return { endpoint: access.endpoint, access, serve, shutdown, closeConnections, exit };
    }),
);

type HostEvent = "SIGTERM" | "SIGINT" | "creator-gone";

/**
 * Runs `commit`; if it fails or is interrupted, restores the saved endpoint state and re-fails
 * with the original cause. If that restore itself fails, logs it and appends recovery guidance to
 * the original failure's message instead of letting the restore failure replace or mask it.
 */
export const commitOrRestoreEndpointReplan = <A>(
  state: State.Interface,
  registered: State.SavedStack,
  changedKeys: ReadonlyArray<{ readonly key: string }>,
  commit: Effect.Effect<A, StackHostError>,
): Effect.Effect<A, StackHostError> =>
  commit.pipe(
    Effect.catchCause((cause: Cause.Cause<StackHostError>) =>
      Effect.gen(function* () {
        const restoreExit = yield* restoreFailedEndpointReplan(state, registered, changedKeys).pipe(
          Effect.exit,
        );
        if (Exit.isSuccess(restoreExit)) return yield* Effect.failCause(cause);
        yield* Effect.logError(
          "Restoring the saved endpoint state failed after a failed re-plan",
          restoreExit.cause,
        );
        const failure = Cause.findErrorOption(cause);
        if (Option.isNone(failure)) return yield* Effect.failCause(cause);
        return yield* new StackHostError({
          ...failure.value,
          message: `${failure.value.message} The saved endpoint state could not be restored either: stop the stack, then start it again, or destroy it to recreate it.`,
        });
      }),
    ),
  );

export const runStackHost = Effect.fn("StackHost.run")(
  (options: StackHostOptions): Effect.Effect<void, StackHostError, never> =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.bounded<HostEvent>(8);
        yield* Effect.forkScoped(
          Effect.forever(
            requestSignal().pipe(
              Effect.flatMap((signal) => Queue.offer(events, signal).pipe(Effect.asVoid)),
            ),
          ),
        );
        const stateContext = yield* Layer.build(State.layer({ root: options.stateRoot }));
        const state = Context.get(stateContext, State.Service);
        const id = options.stackId;
        // The lease is released last, after every owned process and listener has closed.
        if (!(yield* state.lease(id)))
          return yield* new StackHostError({
            operation: "lease",
            message: `Another owner holds the lease of stack ${id}`,
            reason: "lease-held",
          });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.truncate(state.ownerLog(id)).pipe(Effect.ignore);
        yield* state.retractHolder(id);
        const register = options.register;
        if (register !== undefined)
          yield* state.withLock(
            Effect.gen(function* () {
              if ((yield* state.read(id)) !== undefined)
                return yield* new StackHostError({
                  operation: "register",
                  message: "Stack already exists; use open",
                  reason: "exists",
                });
              yield* state.save(register);
            }),
          );
        const started = yield* Effect.gen(function* () {
          const registered = yield* state.read(id);
          if (registered === undefined)
            return yield* hostError("startup", "Stack is not registered");
          // Re-plans a changed endpoint's port against the saved state while this process alone
          // holds the lease, before any owner registers its endpoint namespaces from it; a
          // concurrent launcher that loses the lease race never reaches here and simply attaches
          // to whichever owner wins. `saved` already has the changed endpoints' old claims
          // dropped; the document commits this below, as late as practical, and the owner's own
          // normal endpoint binding claims the new ones through the same `Ports.acquire` path and
          // checks a live composition bind already applies.
          const preparation =
            options.requestedCreations === undefined
              ? undefined
              : yield* prepareEndpointReplan(registered, options.requestedCreations).pipe(
                  Effect.mapError((cause) => hostError("startup", cause)),
                );
          const saved = preparation?.saved ?? registered;
          const control = yield* bindControl();
          const dataRootPath = path.join(options.stateRoot, saved.id, "data");
          yield* fs.makeDirectory(dataRootPath, { recursive: true });
          const dataRoot = yield* fs.realPath(dataRootPath);
          const project = projectSegmentFor(saved.identity, path);
          yield* Owner.sweepContainers(saved, dataRoot).pipe(
            Effect.mapError((cause) =>
              hostError(
                "startup-cleanup",
                cause,
                cause.reason === "engine-unavailable" ? "runtime-unavailable" : undefined,
              ),
            ),
          );
          const hostGateway = yield* makeHostGateway;
          const services = yield* Layer.build(
            Layer.merge(
              Owner.layer({
                saved,
                root: dataRoot,
                cacheRoot: options.cacheRoot,
                hostGateway,
              }),
              CommandRunner.layer({
                stackId: saved.id,
                project,
                root: dataRoot,
                cacheRoot: options.cacheRoot,
                runtime: saved.runtime,
                hostGateway,
              }),
            ).pipe(Layer.provide(Layer.succeed(State.Service, state))),
          );
          const owner = Context.get(services, Owner.Service);
          // The document is saved here, as late as practical, because the owner's own endpoint
          // binding below reads it back through the same `Ports.acquire` path a live composition
          // bind uses. This commits before the owner serves RPC or publishes its holder below, so
          // no attached client can race it: a failure here restores the exact document read before
          // the re-plan, while this process still alone holds the lease; a hard process death in
          // this window is an accepted limitation, and the next successful start converges the
          // saved state again. A failure after this point must not trigger that restore, since by
          // then a client may already have attached and persisted its own acknowledged change.
          const commitReplan: Effect.Effect<
            ReadonlyArray<EndpointPortChange>,
            StackHostError
          > = Effect.gen(function* () {
            if (preparation !== undefined)
              yield* state
                .withLock(state.save(saved))
                .pipe(Effect.mapError((cause) => hostError("startup", cause)));
            if (preparation === undefined) return [];
            return yield* owner.claimEndpoints(preparation.changedInstanceIds).pipe(
              Effect.mapError((cause) => hostError("startup", cause)),
              Effect.andThen(
                state.read(saved.id).pipe(
                  Effect.mapError((cause) => hostError("startup", cause)),
                  Effect.map((after) => reportedEndpointChanges(preparation.changedKeys, after)),
                ),
              ),
            );
          });
          const startupEndpointChanges: ReadonlyArray<EndpointPortChange> =
            preparation === undefined
              ? yield* commitReplan
              : yield* commitOrRestoreEndpointReplan(
                  state,
                  registered,
                  preparation.changedKeys,
                  commitReplan,
                );
          const endpoint: HostEndpoint = {
            stackId: saved.id,
            identity: saved.identity,
            pid: process.pid,
            port: control.port,
            release: options.release ?? (yield* currentRelease),
          };
          const crypto = yield* Crypto.Crypto;
          const secret = Array.from(yield* crypto.randomBytes(32), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          const access: HostAccess = { endpoint, secret };
          const runtime = yield* makeRuntime(
            owner,
            access,
            control.server,
            control.closeConnections,
            startupEndpointChanges,
          ).pipe(
            Effect.provideService(
              CommandRunner.Service,
              Context.get(services, CommandRunner.Service),
            ),
          );
          yield* runtime.serve;
          yield* Effect.addFinalizer(() => state.retractHolder(id).pipe(Effect.ignore));
          yield* state.publishHolder(id, {
            role: "owner",
            secret,
            port: endpoint.port,
            pid: endpoint.pid,
            release: endpoint.release,
            lifetime: saved.lifetime,
            startedAt: DateTime.formatIso(yield* DateTime.now),
          });
          if (saved.lifetime === "session")
            yield* Effect.forkScoped(
              creatorGone.pipe(Effect.andThen(Queue.offer(events, "creator-gone"))),
            );
          yield* options.onReady?.(access) ?? Effect.void;
          yield* Effect.forkScoped(
            sweepOrphans({
              state,
              stateRoot: options.stateRoot,
              cacheRoot: options.cacheRoot,
              ownerId: id,
            }),
          );
          return runtime;
        }).pipe(
          Effect.raceFirst(
            Queue.take(events).pipe(
              Effect.flatMap((event) =>
                hostError(
                  "startup",
                  event === "creator-gone"
                    ? "The session stack's creator exited during startup"
                    : `Received ${event} during startup`,
                ),
              ),
            ),
          ),
          // A stack registered by this owner must not outlive a failed start.
          Effect.onError(() =>
            register === undefined ? Effect.void : state.remove(id).pipe(Effect.ignore),
          ),
        );
        while (true) {
          const event = yield* Deferred.await(started.exit).pipe(
            Effect.map(() => "done" as const),
            Effect.raceFirst(Queue.take(events)),
          );
          if (event === "done") break;
          if (event === "creator-gone") {
            yield* started.shutdown(true).pipe(
              Effect.tapCause((cause) => Effect.logError("Session stack destroy failed", cause)),
              Effect.ignore,
            );
            break;
          }
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

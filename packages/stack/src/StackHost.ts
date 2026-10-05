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
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  PlatformError,
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
import { ChildProcessSpawner } from "effect/unstable/process";
import { projectSegmentFor } from "./identity/Identity.ts";
import * as Owner from "./Owner.ts";
import { StackError, stackError, StackRpc, type RunCommandPayload } from "./Rpc.ts";
import { makeHostGateway, resolveEngineTarget } from "./runtime/Container.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { sweepOrphans } from "./Sweep.ts";
import { makeCommandAttachments } from "./host/CommandAttachments.ts";
import * as CommandRunner from "./host/CommandRunner.ts";

/**
 * How often an owner confirms its own registration still exists. Internal only: tests shorten
 * it through a dedicated entrypoint that overrides this reference, never through env or `Config`.
 */
export const RegistrationCheckInterval = Context.Reference<Duration.Input>(
  "@supabase/stack/RegistrationCheckInterval",
  { defaultValue: () => "30 seconds" },
);

export interface StackHostOptions {
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly stackId: string;
  /** Registers this definition once the owner holds the lease; the stack must not exist. */
  readonly register?: StackNamespace.SavedStack;
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

/**
 * Matches an engine CLI that is missing or reports a daemon that is not listening, never one
 * that rejects the caller (for example on permissions), so `destroy`/`shutdown` (`effect.ts`)
 * know to leave a stack registered for retry instead of surfacing a hard failure.
 * Unrelated to abandonment's own cleanup-retry decision, which probes the engine directly instead
 * of matching a message at all.
 */
const engineUnreachableAtStartup = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    (cause instanceof Object &&
      "cause" in cause &&
      cause.cause instanceof PlatformError.PlatformError &&
      cause.cause.reason._tag === "NotFound" &&
      cause.cause.reason.method === "spawn") ||
    /cannot connect to the docker daemon|connection refused|connect: no such file or directory|error during connect:[^\n]*(?:docker daemon is not running|the system cannot find the file specified)/iu.test(
      message,
    )
  );
};

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
  /** Ends ownership after a confirmed-gone registration; joins an already-running shutdown. */
  readonly abandon: Effect.Effect<void>;
  readonly exit: Deferred.Deferred<void>;
}

export const makeRuntime = Effect.fn("StackHost.makeRuntime")(
  (
    owner: Owner.Interface,
    access: HostAccess,
    server: HttpServer.HttpServer["Service"],
    closeConnections: Effect.Effect<void>,
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
      type ShutdownMode = "stop" | "destroy" | "abandon";
      const current = yield* Ref.make<
        { readonly mode: ShutdownMode; readonly fiber: Fiber.Fiber<void, StackError> } | undefined
      >(undefined);
      const watchResponse = (
        response: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
        closed: Deferred.Deferred<void>,
      ) =>
        Effect.forkIn(
          responseClosed(response).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
          scope,
        );
      // Each stage settles and logs independently: one stage's failure (for example a retained
      // native command's termination that cannot be confirmed) must never skip the others.
      const settled = <E>(label: string, stage: Effect.Effect<void, E>) =>
        stage.pipe(
          Effect.catchCause((cause) => Effect.logError(`Abandoned stack: ${label} failed`, cause)),
        );

      // Admits `mode`'s cleanup when nothing else is in flight: forks it, tracks it as `current`
      // until it settles (success or failure alike), then clears `current` so a later claim —
      // for example abandon after an in-flight stop or destroy — can be admitted again. Only
      // `stop` and `destroy` can actually fail; their own recovery (reopening admission) runs,
      // and `current` is cleared, before `claim` below can ever admit anything else.
      const begin = (
        mode: ShutdownMode,
        response?: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
      ): Effect.Effect<Fiber.Fiber<void, StackError>> =>
        Effect.gen(function* () {
          yield* owner.setDraining(true);
          const responseClosedSignal =
            response === undefined ? undefined : yield* Deferred.make<void>();
          if (response !== undefined && responseClosedSignal !== undefined)
            yield* watchResponse(response, responseClosedSignal);
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
          const body: Effect.Effect<void, StackError> =
            mode === "abandon"
              ? Effect.gen(function* () {
                  // Attachment/command cleanup and namespace cleanup run concurrently; each
                  // retries until confirmed (or the engine is confirmed unavailable), and this
                  // waits for both before the owner is permitted to exit.
                  const commandCleanup = settled(
                    "command cleanup",
                    Owner.retryUntilConfirmed(
                      attachments.stopAll.pipe(Effect.andThen(runner.cleanup)),
                      owner.engineAvailable,
                    ),
                  );
                  const namespaceCleanup = settled(
                    "abandon namespace cleanup",
                    owner.namespace.abandon,
                  );
                  yield* Effect.all([commandCleanup, namespaceCleanup], {
                    concurrency: "unbounded",
                    discard: true,
                  });
                  yield* finish;
                })
              : Effect.gen(function* () {
                  yield* attachments.stopAll;
                  yield* runner.cleanup;
                  yield* mode === "stop" ? owner.namespace.stop : owner.namespace.destroy;
                }).pipe(
                  Effect.andThen(finish),
                  Effect.mapError((cause) => stackError("shutdown", cause)),
                );
          const cleanup = body.pipe(
            Effect.catchCause((cause) =>
              mode !== "abandon"
                ? owner
                    .setDraining(false)
                    // Drain may already have run (and so left the network's own admission
                    // closed) before this later stage failed; recovering it here keeps a
                    // start/restart that follows from refusing as still draining.
                    .pipe(
                      Effect.andThen(owner.namespace.recoverDraining),
                      Effect.andThen(gate.withPermits(1)(Ref.set(current, undefined))),
                      Effect.andThen(Effect.failCause(cause)),
                    )
                : Effect.failCause(cause),
            ),
          );
          const fiber = yield* Effect.forkIn(cleanup, scope);
          yield* Ref.set(current, { mode, fiber });
          return fiber;
        });

      // The one shutdown pipeline: `stop`, `destroy` and `abandon` are claimed
      // through the same gate and `current` record, never a separate join. If a shutdown is
      // already in flight when abandonment is requested, this waits for it to settle (whatever
      // its outcome) and then claims abandon fresh, unless that settlement was a confirmed
      // successful destroy — ownership is already fully ended, so there is nothing left to
      // abandon. Once abandon is claimed, nothing else can supersede it: it always joins.
      const claim = (
        mode: ShutdownMode,
        response?: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
      ): Effect.Effect<void, StackError> =>
        Effect.gen(function* () {
          while (true) {
            const decision = yield* gate.withPermits(1)(
              Effect.uninterruptibleMask(() =>
                Effect.gen(function* () {
                  const existing = yield* Ref.get(current);
                  if (existing === undefined) {
                    const fiber = yield* begin(mode, response);
                    return { _tag: "run", fiber } as const;
                  }
                  if (mode === "abandon")
                    return existing.mode === "abandon"
                      ? ({ _tag: "run", fiber: existing.fiber } as const)
                      : ({
                          _tag: "await",
                          fiber: existing.fiber,
                          priorMode: existing.mode,
                        } as const);
                  if (existing.mode === "abandon")
                    return { _tag: "run", fiber: existing.fiber } as const;
                  if (existing.mode === "destroy" && mode === "stop")
                    return { _tag: "run", fiber: existing.fiber } as const;
                  if (existing.mode === "stop" && mode === "destroy")
                    return yield* new StackError({
                      operation: "shutdown",
                      message: "Shutdown mode is already selected",
                    });
                  return { _tag: "run", fiber: existing.fiber } as const;
                }),
              ),
            );
            if (decision._tag === "run") {
              yield* Fiber.join(decision.fiber);
              return;
            }
            // "await": a prior stop or destroy, whether still running or already settled, is
            // never cleared for its own sake (a repeated `shutdown` call must keep rejoining it
            // for free); only abandon taking over after it clears the slot, so this loop's next
            // pass can claim fresh.
            const outcome = yield* Fiber.join(decision.fiber).pipe(Effect.exit);
            if (decision.priorMode === "destroy" && Exit.isSuccess(outcome)) return;
            yield* gate.withPermits(1)(
              Ref.update(current, (value) => (value?.fiber === decision.fiber ? undefined : value)),
            );
          }
        });
      const shutdown = (
        destroy: boolean,
        response?: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
      ) =>
        claim(destroy ? "destroy" : "stop", response).pipe(
          Effect.mapError((cause) => stackError("shutdown", cause)),
        );
      // A registration-loss poll drives this, never an RPC caller, so there is no response to
      // watch and no registration left to touch; `claim` never actually fails for this mode.
      const abandon = claim("abandon").pipe(Effect.ignore);
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

      return {
        endpoint: access.endpoint,
        access,
        serve,
        shutdown,
        abandon,
        closeConnections,
        exit,
      };
    }),
);

type HostEvent = "SIGTERM" | "SIGINT" | "creator-gone" | "registration-gone";

/**
 * True only on a confirmed ENOENT (`state.read` returning `undefined`); any other error
 * (permissions, an unmounted root mid-read) keeps the owner running, so it reads as "not
 * confirmed gone" rather than abandonment.
 */
const registrationConfirmedGone = Effect.fn("StackHost.registrationConfirmedGone")(function* (
  state: StackNamespace.Interface,
  id: string,
) {
  const saved = yield* state.read(id).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning(
        "Could not confirm the stack registration; keeping the owner running",
        cause,
      ),
    ),
    Effect.option,
  );
  return Option.isSome(saved) && saved.value === undefined;
});

/**
 * Polls for a confirmed-gone registration and offers `registration-gone` once.
 */
const pollRegistration = Effect.fn("StackHost.pollRegistration")(function* (
  state: StackNamespace.Interface,
  id: string,
  events: Queue.Queue<HostEvent>,
) {
  const interval = yield* RegistrationCheckInterval;
  while (true) {
    yield* Effect.sleep(interval);
    if (yield* registrationConfirmedGone(state, id)) {
      yield* Queue.offer(events, "registration-gone");
      return;
    }
  }
});

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
        const stateContext = yield* Layer.build(StackNamespace.layer({ root: options.stateRoot }));
        const state = Context.get(stateContext, StackNamespace.Service);
        const id = options.stackId;
        // The lease is released last, after every owned process and listener has closed.
        const lease = yield* state.acquireLease(id).pipe(
          Effect.catchTag(
            "Namespace.LeaseHeldError",
            () =>
              new StackHostError({
                operation: "lease",
                message: `Another owner holds the lease of stack ${id}`,
                reason: "lease-held",
              }),
          ),
        );
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.truncate(state.ownerLog(id)).pipe(Effect.ignore);
        yield* lease.retractHolder;
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
          const saved = yield* state.read(id);
          if (saved === undefined) return yield* hostError("startup", "Stack is not registered");
          const control = yield* bindControl();
          const dataRootPath = path.join(options.stateRoot, saved.id, "data");
          yield* fs.makeDirectory(dataRootPath, { recursive: true });
          const dataRoot = yield* fs.realPath(dataRootPath);
          const project = projectSegmentFor(saved.identity, path);
          // Resolved once, here, for this owner's whole lifetime: the container runtime, the
          // storage helpers, the host-gateway probes and reconcile below all share this one
          // target instead of each resolving (and so potentially disagreeing on) their own.
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const engineTarget =
            saved.runtime === "native"
              ? undefined
              : yield* resolveEngineTarget(spawner).pipe(
                  Effect.mapError((cause) =>
                    hostError(
                      "startup-cleanup",
                      cause,
                      engineUnreachableAtStartup(cause) ? "runtime-unavailable" : undefined,
                    ),
                  ),
                );
          yield* Owner.sweepContainers(state, saved, dataRoot, engineTarget).pipe(
            Effect.mapError((cause) =>
              hostError(
                "startup-cleanup",
                cause,
                engineUnreachableAtStartup(cause) ? "runtime-unavailable" : undefined,
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
                engineTarget,
              }),
              CommandRunner.layer({
                stackId: saved.id,
                project,
                root: dataRoot,
                cacheRoot: options.cacheRoot,
                runtime: saved.runtime,
                hostGateway,
                engineTarget,
              }),
            ).pipe(Layer.provide(Layer.succeed(StackNamespace.Service, state))),
          );
          const owner = Context.get(services, Owner.Service);
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
          ).pipe(
            Effect.provideService(
              CommandRunner.Service,
              Context.get(services, CommandRunner.Service),
            ),
          );
          yield* runtime.serve;
          yield* Effect.addFinalizer(() => lease.retractHolder.pipe(Effect.ignore));
          yield* lease.publishHolder({
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
          yield* Effect.forkScoped(pollRegistration(state, id, events));
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
          if (event === "registration-gone") {
            yield* started.abandon;
            break;
          }
          const shutdownSucceeded = yield* started.shutdown(false).pipe(
            Effect.tapCause((cause) => Effect.logError("Stack shutdown failed", cause)),
            Effect.matchCause({ onSuccess: () => true, onFailure: () => false }),
          );
          if (!shutdownSucceeded) continue;
          // A registration deletion that arrives while this data-preserving stop is already
          // running only reaches `events` as a queued, now-unread `registration-gone`: a direct
          // re-read through the same state API the poll uses catches it before the owner exits.
          if (yield* registrationConfirmedGone(state, id)) yield* started.abandon;
          break;
        }
      }),
    ).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
      Effect.mapError((cause) =>
        cause instanceof StackHostError ? cause : hostError("host", cause),
      ),
    ),
);

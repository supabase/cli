import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Option,
  Predicate,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import type { ControlEndpoint } from "../state/Ownership.ts";
import {
  CONTROL_PREFACE_MAX_BYTES,
  decodeFrame,
  decodePreface,
  encodeFrame,
  encodePreface,
  encodeRawFrame,
  FrameDecoder,
  MAINTENANCE_MAX_CONCURRENT_REQUESTS,
  MAINTENANCE_REQUEST_DEADLINE_MS,
  MaintenanceRequestSchema,
  MaintenanceProtocolError,
  MaintenanceResponseSchema,
  ownerSessionIdIsValid,
  type JsonValue,
  type MaintenanceRequest,
  type MaintenanceResponse,
} from "./MaintenanceProtocol.ts";
import {
  releaseMismatch,
  STACK_RPC_RELEASE,
  StackRpcGroup,
  type StackRpcClient,
  type StackRpcHandlers,
} from "./StackRpc.ts";

interface ControlIdentity {
  readonly stackId: string;
  readonly ownerSessionId: string;
}

export interface MaintenanceHandlers {
  readonly probe: Effect.Effect<MaintenanceResponse>;
  readonly stop: Effect.Effect<MaintenanceResponse>;
}

export interface ControlServerOptions extends ControlIdentity {
  readonly endpoint: ControlEndpoint;
  readonly rpcRelease?: string;
  readonly maintenanceHandlers: MaintenanceHandlers;
  /** Re-evaluates owner shutdown after a lifecycle response or disconnect. */
  readonly onShutdownReady?: Effect.Effect<void>;
  readonly rpcHandlers: StackRpcHandlers;
}

export interface ControlServer {
  readonly endpoint: ControlEndpoint;
}

const endpointPath = (endpoint: ControlEndpoint): string =>
  endpoint.kind === "unix" ? endpoint.path : endpoint.name;

const toBytes = (chunk: Uint8Array | string): Uint8Array =>
  typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;

const protocolFailure = (
  tag:
    | "invalid-request"
    | "stale-session"
    | "timeout"
    | "operation-failed"
    | "unsupported-release" = "invalid-request",
): MaintenanceResponse => ({
  ok: false,
  error: { tag, message: "Control request rejected" },
});

const isResponseConnectionFailure = (cause: Cause.Cause<Socket.SocketError>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      Predicate.isTagged(error.reason, "SocketWriteError") ||
      Predicate.isTagged(error.reason, "SocketCloseError"),
  });

/** Wrap one accepted socket. This is the only reader for the connection. */
const demuxSocket = (
  socket: Socket.Socket,
  options: ControlServerOptions,
  maintenanceSemaphore: Semaphore.Semaphore,
  completionFibers: FiberSet.FiberSet,
): Socket.Socket => {
  const expectedRelease = options.rpcRelease ?? STACK_RPC_RELEASE;
  type Writer = (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  let connectionWriter: Writer | undefined;

  const runRaw = <A, E, R>(
    handler: (_: Uint8Array) => Effect.Effect<A, E, R> | void,
    runOptions?: { readonly onOpen?: Effect.Effect<void> },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        const writerReady = yield* Deferred.make<Writer>();
        const underlyingWrite = yield* socket.writer;
        const decoder = new FrameDecoder();
        const prefaceReady = yield* Deferred.make<void>();
        let preface = new Uint8Array(0);
        let phase: "preface" | "maintenance" | "rpc" = "preface";
        let closed = false;

        const markPrefaceReady = Deferred.succeed(prefaceReady, undefined).pipe(Effect.asVoid);
        const close = Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          return markPrefaceReady.pipe(
            Effect.andThen(
              Deferred.await(writerReady).pipe(
                Effect.flatMap((write) => write(new Socket.CloseEvent(1000))),
              ),
            ),
          );
        });

        const socketWriteError = (message: string) =>
          new Socket.SocketError({
            reason: new Socket.SocketWriteError({ cause: new Error(message) }),
          });
        const sendJson = (value: JsonValue): Effect.Effect<void, Socket.SocketError> =>
          Deferred.await(writerReady).pipe(
            Effect.flatMap((write) =>
              encodeFrame(value).pipe(
                Effect.mapError((error) => socketWriteError(error.message)),
                Effect.flatMap(write),
              ),
            ),
          );

        type MaintenanceValidation =
          | { readonly _tag: "invalid-request" }
          | { readonly _tag: "stale-session"; readonly request: MaintenanceRequest }
          | { readonly _tag: "valid"; readonly request: MaintenanceRequest };

        const dispatchMaintenance = (
          validation: MaintenanceValidation,
        ): Effect.Effect<void, Socket.SocketError> => {
          let responseValue: MaintenanceResponse | undefined;
          let operationName: MaintenanceRequest["op"] | undefined;
          let completionStarted = false;
          const startCompletion = (completion: Effect.Effect<void>) =>
            Effect.uninterruptible(
              FiberSet.run(completionFibers, completion, { startImmediately: true }).pipe(
                // This witness is set only after the completion fiber has been
                // handed to the owner-scoped FiberSet. The uninterruptible
                // region keeps the fork and witness atomic to dispatch/onExit.
                Effect.tap(() =>
                  Effect.sync(() => {
                    completionStarted = true;
                  }),
                ),
              ),
            );
          const dispatch = Effect.gen(function* () {
            if (validation._tag === "invalid-request") {
              yield* sendJson(protocolFailure("invalid-request"));
              yield* close;
              return;
            }
            if (validation._tag === "stale-session") {
              yield* sendJson(protocolFailure("stale-session"));
              yield* close;
              return;
            }
            const request = validation.request;
            operationName = request.op;
            const operation =
              request.op === "probe"
                ? options.maintenanceHandlers.probe
                : options.maintenanceHandlers.stop;
            const result = yield* Effect.exit(operation);
            const response = Exit.isSuccess(result)
              ? result.value
              : protocolFailure("operation-failed");
            responseValue = response;
            yield* sendJson(response);
            yield* close;
            if (request.op === "stop" && options.onShutdownReady !== undefined) {
              // The connection scope closes as soon as the close frame is sent;
              // completion belongs to the owner session and must outlive it.
              yield* startCompletion(options.onShutdownReady);
            }
          });
          return dispatch.pipe(
            Effect.onExit((exit) => {
              const response = responseValue;
              if (response === undefined || operationName !== "stop") return Effect.void;
              if (Exit.isSuccess(exit)) return Effect.void;
              const connectionFailure =
                Cause.hasInterruptsOnly(exit.cause) || isResponseConnectionFailure(exit.cause);
              if (!connectionFailure || completionStarted || options.onShutdownReady === undefined)
                return Effect.void;
              return startCompletion(options.onShutdownReady).pipe(Effect.asVoid);
            }),
            Effect.catchReasons("SocketError", {
              SocketWriteError: () => Effect.void,
              SocketCloseError: () => Effect.void,
            }),
          );
        };

        const processFrames = (input: Uint8Array): Effect.Effect<void, Socket.SocketError | E, R> =>
          Effect.gen(function* () {
            const result = yield* Effect.exit(decoder.push(input));
            if (Exit.isFailure(result)) {
              yield* close;
              return;
            }
            for (const frame of result.value) {
              if (closed) break;
              if (phase === "maintenance") {
                // Probe and request validation are bounded by the maintenance admission
                // deadline. A validated stop owns its full cleanup operation and may
                // legitimately outlive that connection deadline; the caller joins the result.
                // The preface deadline only governs admission until the first frame arrives;
                // once a frame is present, dispatch owns the remaining validation/operation
                // policy below.
                yield* markPrefaceReady;
                const operation = yield* Effect.exit(
                  decodeFrame(frame).pipe(
                    Effect.flatMap((decoded) =>
                      Schema.decodeUnknownEffect(MaintenanceRequestSchema)(decoded, {
                        onExcessProperty: "error",
                      }),
                    ),
                  ),
                );
                const validation: MaintenanceValidation = Exit.isFailure(operation)
                  ? { _tag: "invalid-request" }
                  : operation.value.stackId !== options.stackId
                    ? { _tag: "invalid-request" }
                    : operation.value.ownerSessionId !== options.ownerSessionId
                      ? { _tag: "stale-session", request: operation.value }
                      : { _tag: "valid", request: operation.value };
                const dispatch = maintenanceSemaphore.withPermit(dispatchMaintenance(validation));
                if (validation._tag === "valid" && validation.request.op !== "probe") {
                  yield* dispatch;
                } else {
                  yield* dispatch.pipe(
                    Effect.timeoutOrElse({
                      duration: MAINTENANCE_REQUEST_DEADLINE_MS,
                      orElse: () =>
                        sendJson(protocolFailure("timeout")).pipe(Effect.andThen(close)),
                    }),
                  );
                }
              } else {
                const returned = handler(frame.slice(4));
                if (Effect.isEffect(returned)) yield* returned;
              }
            }
          });

        const processChunk = (
          chunk: Uint8Array | string,
        ): Effect.Effect<void, Socket.SocketError | E, R> =>
          Effect.gen(function* () {
            if (closed) return;
            const input = toBytes(chunk);
            if (phase === "preface") {
              const combined = new Uint8Array(preface.byteLength + input.byteLength);
              combined.set(preface);
              combined.set(input, preface.byteLength);
              const newline = combined.indexOf(10);
              if (
                (newline < 0 && combined.byteLength > CONTROL_PREFACE_MAX_BYTES) ||
                (newline >= 0 && newline + 1 > CONTROL_PREFACE_MAX_BYTES)
              ) {
                yield* sendJson(protocolFailure("invalid-request"));
                yield* close;
                return;
              }
              preface = combined;
              const decoded = yield* Effect.exit(decodePreface(combined));
              if (Exit.isFailure(decoded)) {
                if (preface.includes(10)) {
                  yield* sendJson(protocolFailure());
                  yield* close;
                }
                return;
              }
              phase = decoded.value.protocol.kind;
              preface = new Uint8Array(0);
              if (
                decoded.value.protocol.stackId === undefined ||
                decoded.value.protocol.ownerSessionId === undefined ||
                !ownerSessionIdIsValid(decoded.value.protocol.ownerSessionId)
              ) {
                yield* sendJson(protocolFailure("invalid-request"));
                yield* close;
                return;
              }
              if (decoded.value.protocol.stackId !== options.stackId) {
                yield* sendJson(protocolFailure("invalid-request"));
                yield* close;
                return;
              }
              if (decoded.value.protocol.ownerSessionId !== options.ownerSessionId) {
                yield* sendJson(protocolFailure("stale-session"));
                yield* close;
                return;
              }
              if (phase === "rpc" && decoded.value.protocol.release !== expectedRelease) {
                yield* sendJson({
                  ok: false,
                  error: {
                    tag: "unsupported-release",
                    message: releaseMismatch(decoded.value.protocol.release).message,
                  },
                });
                yield* close;
                return;
              }
              if (phase === "rpc") yield* markPrefaceReady;
              const remainder = combined.slice(decoded.value.consumed);
              if (remainder.byteLength > 0) yield* processFrames(remainder);
              return;
            }
            yield* processFrames(input);
          });

        const onOpen = Effect.andThen(
          Effect.sync(() => {
            connectionWriter = underlyingWrite;
          }).pipe(
            Effect.andThen(Deferred.succeed(writerReady, underlyingWrite).pipe(Effect.asVoid)),
          ),
          runOptions?.onOpen ?? Effect.void,
        );
        const prefaceDeadline = yield* Effect.forkChild(
          Deferred.await(prefaceReady).pipe(
            Effect.timeoutOrElse({
              duration: MAINTENANCE_REQUEST_DEADLINE_MS,
              orElse: () => sendJson(protocolFailure("timeout")).pipe(Effect.andThen(close)),
            }),
          ),
        );
        yield* socket.runRaw(processChunk, { onOpen });
        yield* Fiber.interrupt(prefaceDeadline);
      }),
    ).pipe(
      Effect.catchReasons("SocketError", {
        SocketReadError: () => Effect.void,
        SocketCloseError: () => Effect.void,
      }),
    );

  return Socket.make({
    runRaw,
    writer: Effect.succeed((chunk: Uint8Array | string | Socket.CloseEvent) => {
      const write = connectionWriter;
      if (write === undefined) {
        return Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketWriteError({ cause: new Error("Control socket is not open") }),
          }),
        );
      }
      return Socket.isCloseEvent(chunk)
        ? write(chunk)
        : encodeRawFrame(chunk).pipe(
            Effect.mapError(
              (error) =>
                new Socket.SocketError({
                  reason: new Socket.SocketWriteError({ cause: new Error(error.message) }),
                }),
            ),
            Effect.flatMap(write),
          );
    }),
  });
};

const wrappedServer = (
  base: SocketServer.SocketServer["Service"],
  options: ControlServerOptions,
  maintenanceSemaphore: Semaphore.Semaphore,
  completionFibers: FiberSet.FiberSet,
): SocketServer.SocketServer["Service"] =>
  SocketServer.SocketServer.of({
    address: base.address,
    run: (handler) => {
      return base.run((socket) => {
        return handler(demuxSocket(socket, options, maintenanceSemaphore, completionFibers));
      });
    },
  });

/** Bind the one local endpoint and serve maintenance plus exact-release RPC. */
export const startControlServer = (
  options: ControlServerOptions,
): Effect.Effect<
  ControlServer,
  SocketServer.SocketServerError,
  Scope.Scope | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* NodeSocketServer.make({ path: endpointPath(options.endpoint) });
    if (options.endpoint.kind === "unix") {
      const unixPath = options.endpoint.path;
      yield* Effect.addFinalizer(() =>
        fs
          .remove(unixPath, { force: true })
          .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
      );
      yield* fs.chmod(options.endpoint.path, 0o600).pipe(
        Effect.mapError(
          (error) =>
            new SocketServer.SocketServerError({
              reason: new SocketServer.SocketServerOpenError({ cause: error }),
            }),
        ),
      );
    }
    const maintenanceSemaphore = yield* Semaphore.make(MAINTENANCE_MAX_CONCURRENT_REQUESTS);
    const completionFibers = yield* FiberSet.make();
    const server = wrappedServer(base, options, maintenanceSemaphore, completionFibers);
    const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
      Effect.provideService(SocketServer.SocketServer, server),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
    );
    const isCompletionRequest = (tag: string): boolean => tag === "start" || tag === "destroy";
    const completionRequests = new Set<string>();
    const startShutdown = (completion: Effect.Effect<void>) =>
      Effect.uninterruptible(
        FiberSet.run(completionFibers, completion, { startImmediately: true }).pipe(Effect.asVoid),
      );
    const patchedProtocol = RpcServer.Protocol.of({
      ...protocol,
      run: (handler) =>
        protocol.run((clientId, request) => {
          if (Predicate.isTagged(request, "Request") && isCompletionRequest(request.tag))
            completionRequests.add(`${clientId}:${String(request.id)}`);
          return handler(clientId, request);
        }),
      send: (clientId, response, transferables) =>
        Predicate.isTagged(response, "Exit") &&
        completionRequests.has(`${clientId}:${String(response.requestId)}`)
          ? Effect.gen(function* () {
              const key = `${clientId}:${String(response.requestId)}`;
              const connected = (yield* protocol.clientIds).has(clientId);
              if (connected) yield* Effect.exit(protocol.send(clientId, response, transferables));
              const completed = completionRequests.delete(key);
              if (completed && options.onShutdownReady !== undefined)
                yield* startShutdown(options.onShutdownReady);
            })
          : protocol.send(clientId, response, transferables),
    });
    // Keep handler defects as keyed Exit responses so lifecycle-completion request state can be
    // cleaned by the same send path as typed failures. Without this option RpcServer emits a
    // client-level Defect frame that has no requestId for the terminal handoff.
    const rpcProgram: Effect.Effect<never, never> = RpcServer.make(StackRpcGroup, {
      disableTracing: true,
      disableFatalDefects: true,
      concurrency: MAINTENANCE_MAX_CONCURRENT_REQUESTS,
    }).pipe(
      Effect.provideService(RpcServer.Protocol, patchedProtocol),
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
      Effect.provide(StackRpcGroup.toLayer(options.rpcHandlers)),
    );
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
    yield* Effect.forkScoped(rpcProgram);
    return {
      endpoint: options.endpoint,
    } satisfies ControlServer;
  });

/** Client-side framed socket; writer emits the RPC preface exactly once. */
const makeControlRpcSocket = (
  socket: Socket.Socket,
  options: {
    readonly rpcRelease?: string;
    readonly stackId: string;
    readonly ownerSessionId: string;
  },
): Socket.Socket => {
  let prefaced = false;
  return Socket.make({
    runRaw: (handler, options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const decoder = new FrameDecoder();
          yield* socket.runRaw(
            (chunk) =>
              decoder.push(toBytes(chunk)).pipe(
                Effect.mapError(
                  (error) =>
                    new Socket.SocketError({
                      reason: new Socket.SocketReadError({ cause: new Error(error.message) }),
                    }),
                ),
                Effect.flatMap((frames) =>
                  Effect.forEach(frames, (frame) =>
                    Effect.suspend(() => {
                      const effect = handler(frame.slice(4));
                      return Effect.isEffect(effect) ? effect : Effect.void;
                    }),
                  ).pipe(Effect.asVoid),
                ),
              ),
            options,
          );
        }),
      ),
    writer: Effect.map(
      socket.writer,
      (write) => (chunk: Uint8Array | string | Socket.CloseEvent) =>
        Effect.gen(function* () {
          if (Socket.isCloseEvent(chunk)) {
            yield* write(chunk);
            return;
          }
          const encodedFrame = yield* encodeRawFrame(chunk).pipe(
            Effect.mapError(
              (error) =>
                new Socket.SocketError({
                  reason: new Socket.SocketWriteError({ cause: new Error(error.message) }),
                }),
            ),
          );
          if (!prefaced) {
            prefaced = true;
            const preface = encodePreface({
              kind: "rpc",
              release: options.rpcRelease ?? STACK_RPC_RELEASE,
              stackId: options.stackId,
              ownerSessionId: options.ownerSessionId,
            });
            const combined = new Uint8Array(preface.byteLength + encodedFrame.byteLength);
            combined.set(preface);
            combined.set(encodedFrame, preface.byteLength);
            yield* write(combined);
            return;
          }
          yield* write(encodedFrame);
        }),
    ),
  });
};

export interface ControlClientOptions extends ControlIdentity {
  readonly rpcRelease?: string;
}

export interface ControlClient {
  // Each call allocates a fresh scoped socket, so these methods intentionally
  // return per-call lazy Effects rather than shared Effect values.
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly probe: () => Effect.Effect<
    MaintenanceResponse,
    Socket.SocketError | MaintenanceProtocolError
  >;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly stop: () => Effect.Effect<
    MaintenanceResponse,
    Socket.SocketError | MaintenanceProtocolError
  >;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  /** Connects with an RPC preface and completes when the owner closes the socket. */
  readonly awaitClose: (onOpen?: Effect.Effect<void>) => Effect.Effect<void, Socket.SocketError>;
  readonly rpc: Effect.Effect<StackRpcClient, RpcClientError, Scope.Scope>;
}

/** A scoped client seam used by the Supervisor entrypoint and public Stack handles. */
export const makeControlClient = (
  endpoint: ControlEndpoint,
  options: ControlClientOptions,
): ControlClient => {
  const maintenance = (
    op: MaintenanceRequest["op"],
  ): Effect.Effect<MaintenanceResponse, Socket.SocketError | MaintenanceProtocolError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* NodeSocket.makeNet({
          path: endpointPath(endpoint),
          openTimeout: MAINTENANCE_REQUEST_DEADLINE_MS,
        });
        const underlyingWrite = yield* socket.writer;
        const decoder = new FrameDecoder();
        const response = yield* Deferred.make<MaintenanceResponse, never>();
        const writerReady =
          yield* Deferred.make<
            (
              chunk: Uint8Array | string | Socket.CloseEvent,
            ) => Effect.Effect<void, Socket.SocketError>
          >();
        const read = socket.runRaw(
          (chunk) =>
            decoder.push(toBytes(chunk)).pipe(
              Effect.flatMap((frames) =>
                Effect.forEach(frames, (frame) =>
                  Effect.gen(function* () {
                    const decoded = yield* Effect.exit(decodeFrame(frame));
                    if (Exit.isFailure(decoded)) return;
                    const parsed = yield* Effect.exit(
                      Schema.decodeUnknownEffect(MaintenanceResponseSchema)(decoded.value, {
                        onExcessProperty: "error",
                      }),
                    );
                    if (Exit.isSuccess(parsed)) yield* Deferred.succeed(response, parsed.value);
                  }),
                ).pipe(Effect.asVoid),
              ),
            ),
          {
            onOpen: Deferred.succeed(writerReady, underlyingWrite).pipe(Effect.asVoid),
          },
        );
        const fiber = yield* Effect.forkChild(read);
        // NodeSocket opens its writer as part of runRaw's onOpen hook.
        const write = yield* Deferred.await(writerReady);
        yield* write(
          encodePreface({
            kind: "maintenance",
            release: "maintenance-v1",
            stackId: options.stackId,
            ownerSessionId: options.ownerSessionId,
          }),
        );
        yield* encodeFrame({
          op,
          stackId: options.stackId,
          ownerSessionId: options.ownerSessionId,
        }).pipe(Effect.flatMap(write));
        // The server closes a successful maintenance connection immediately
        // after flushing its response. Check the response witness after the
        // reader exits so the close event cannot win that handoff race.
        const readerDone = Effect.exit(Fiber.join(fiber)).pipe(
          Effect.flatMap(() => Deferred.poll(response)),
          Effect.flatMap((completed) =>
            Option.isSome(completed)
              ? completed.value
              : Effect.fail(
                  new MaintenanceProtocolError({
                    message: "Control connection closed",
                    reason: "transport",
                  }),
                ),
          ),
        );
        const wait = Effect.raceFirst(Deferred.await(response), readerDone).pipe(
          Effect.ensuring(Fiber.interrupt(fiber)),
        );
        return yield* wait;
      }),
    );

  return {
    probe: () =>
      maintenance("probe").pipe(
        Effect.timeoutOrElse({
          duration: MAINTENANCE_REQUEST_DEADLINE_MS,
          orElse: () =>
            Effect.fail(
              new MaintenanceProtocolError({
                message: "Control request timed out",
                reason: "transport",
              }),
            ),
        }),
      ),
    stop: () => maintenance("stop"),
    awaitClose: (onOpen = Effect.void) =>
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* NodeSocket.makeNet({
            path: endpointPath(endpoint),
            openTimeout: MAINTENANCE_REQUEST_DEADLINE_MS,
          });
          const write = yield* socket.writer;
          const prefaceFailure = yield* Deferred.make<never, Socket.SocketError>();
          const read = socket.runRaw(() => Effect.void, {
            onOpen: write(
              encodePreface({
                kind: "rpc",
                release: options.rpcRelease ?? STACK_RPC_RELEASE,
                stackId: options.stackId,
                ownerSessionId: options.ownerSessionId,
              }),
            ).pipe(
              Effect.matchEffect({
                onFailure: (error) => Deferred.fail(prefaceFailure, error).pipe(Effect.asVoid),
                onSuccess: () => onOpen,
              }),
            ),
          });
          return yield* Effect.raceFirst(read, Deferred.await(prefaceFailure)).pipe(
            Effect.catchFilter(
              Socket.SocketCloseError.filterClean((code) => code === 1000),
              () => Effect.void,
            ),
          );
        }),
      ),
    rpc: Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({
        path: endpointPath(endpoint),
        openTimeout: MAINTENANCE_REQUEST_DEADLINE_MS,
      });
      const controlSocket = makeControlRpcSocket(socket, {
        rpcRelease: options.rpcRelease,
        stackId: options.stackId,
        ownerSessionId: options.ownerSessionId,
      });
      const protocol = yield* RpcClient.makeProtocolSocket().pipe(
        Effect.provideService(Socket.Socket, controlSocket),
        Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
      );
      return yield* RpcClient.make(StackRpcGroup).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
    }),
  };
};

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
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect FileSystem exposes stat but no no-follow lstat; this security check must reject symlinked control directories.
import { lstat } from "node:fs/promises";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import type { ControlEndpoint } from "../state/Ownership.ts";
import { isStackError, type StackError } from "../public/Errors.ts";
import {
  decodeFrame,
  encodeFrame,
  encodeRawFrame,
  FrameDecoder,
  MAINTENANCE_MAX_FRAME_BYTES,
  RPC_MAX_FRAME_BYTES,
  type JsonValue,
} from "./FrameCodec.ts";
import {
  CONTROL_PREFACE_MAX_BYTES,
  decodePreface,
  encodePreface,
  MAINTENANCE_MAX_CONCURRENT_REQUESTS,
  MAINTENANCE_REQUEST_DEADLINE_MS,
  MaintenanceRequestSchema,
  MaintenanceProtocolError,
  MaintenanceResponseSchema,
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

/** Keeps the owner admitted from a validated RPC preface through its first request. */
export interface RpcPrefaceLease {
  readonly release: Effect.Effect<void>;
}

export interface ControlServerOptions extends ControlIdentity {
  readonly endpoint: ControlEndpoint;
  readonly rpcRelease?: string;
  readonly maintenanceHandlers: MaintenanceHandlers;
  /** Re-evaluates owner shutdown after a lifecycle response or disconnect. */
  readonly onShutdownReady?: Effect.Effect<void>;
  /** Acquires an owner admission witness before acknowledging an RPC preface. */
  readonly onRpcPreface?: () => Effect.Effect<RpcPrefaceLease, StackError>;
  readonly rpcHandlers: StackRpcHandlers;
}

export interface ControlServer {
  readonly endpoint: ControlEndpoint;
}

const endpointPath = (endpoint: ControlEndpoint): string =>
  endpoint.kind === "unix" ? endpoint.path : endpoint.name;

const controlDirectory = (endpoint: ControlEndpoint): string => {
  const path = endpointPath(endpoint);
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? path : path.slice(0, separator);
};

const RpcMessageTagSchema = Schema.fromJsonString(Schema.Struct({ _tag: Schema.String }));

const rpcMessageTag = (chunk: Uint8Array | string): Effect.Effect<string | undefined> => {
  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  return Schema.decodeEffect(RpcMessageTagSchema)(text).pipe(
    Effect.map(({ _tag }) => _tag),
    Effect.orElseSucceed(() => undefined),
  );
};

const controlServerError = (cause: unknown): SocketServer.SocketServerError =>
  new SocketServer.SocketServerError({
    reason: new SocketServer.SocketServerOpenError({ cause }),
  });

/**
 * Ensure the Unix endpoint is inside an owner-private directory. FileSystem.stat follows
 * symlinks, so the no-follow lstat is required at this security boundary.
 */
const ensurePrivateControlDirectory = (
  fs: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<boolean, SocketServer.SocketServerError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(directory).pipe(Effect.mapError(controlServerError));
    let created = false;
    if (!exists) {
      yield* fs.makeDirectory(directory, { mode: 0o700 }).pipe(Effect.mapError(controlServerError));
      created = true;
    }
    const info = yield* Effect.tryPromise({
      try: () => lstat(directory),
      catch: (cause) => controlServerError(cause),
    });
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0)
      return yield* controlServerError(
        new Error("Control endpoint directory is not owner-private"),
      );
    yield* fs.chmod(directory, 0o700).pipe(Effect.mapError(controlServerError));
    return created;
  });

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

const rpcPrefaceFailure = (error: StackError): JsonValue => ({
  kind: "rpc-retiring",
  stackId: "stackId" in error && typeof error.stackId === "string" ? error.stackId : "",
  ownerSessionId:
    "ownerSessionId" in error && typeof error.ownerSessionId === "string"
      ? error.ownerSessionId
      : "",
  error: {
    tag: error._tag,
    message: error.message,
    ...(isStackError(error) && "stackId" in error && typeof error.stackId === "string"
      ? { stackId: error.stackId }
      : {}),
    ...(isStackError(error) && "ownerSessionId" in error && typeof error.ownerSessionId === "string"
      ? { ownerSessionId: error.ownerSessionId }
      : {}),
  },
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
  let phase: "preface" | "maintenance" | "rpc" = "preface";
  let firstRpcRequestSeen = false;
  let rpcPrefaceLease: RpcPrefaceLease | undefined;
  let releaseRpcPreface: (notify: boolean) => Effect.Effect<void> = () => Effect.void;

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
        let closed = false;
        phase = "preface";
        firstRpcRequestSeen = false;
        rpcPrefaceLease = undefined;

        releaseRpcPreface = (notify: boolean) =>
          Effect.suspend(() => {
            const lease = rpcPrefaceLease;
            rpcPrefaceLease = undefined;
            if (lease === undefined) return Effect.void;
            return lease.release.pipe(
              Effect.andThen(notify ? (options.onShutdownReady ?? Effect.void) : Effect.void),
            );
          });

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
            // A client may disconnect before sending its first RPC frame. Release the
            // preface witness as soon as the close is flushed so owner retirement does not
            // wait for socket reader cleanup.
            Effect.andThen(releaseRpcPreface(true)),
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
                // Set only after the completion fiber is handed to the owner-scoped
                // FiberSet; the uninterruptible region keeps fork and witness atomic
                // with `onExit` below.
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
            const result = yield* Effect.exit(
              decoder.push(
                input,
                phase === "rpc" ? RPC_MAX_FRAME_BYTES : MAINTENANCE_MAX_FRAME_BYTES,
              ),
            );
            if (Exit.isFailure(result)) {
              yield* close;
              return;
            }
            for (const frame of result.value) {
              if (closed) break;
              if (phase === "maintenance") {
                // Probe/validation are bounded by the maintenance admission deadline; a
                // validated stop owns its own cleanup and may outlive it. The preface deadline
                // governs only admission until the first frame arrives — dispatch below owns
                // policy after that.
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
                const tag = yield* rpcMessageTag(frame.slice(4));
                if (tag === "Request") {
                  if (!firstRpcRequestSeen) yield* markPrefaceReady;
                  firstRpcRequestSeen = true;
                }
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
                    message: releaseMismatch(decoded.value.protocol.release),
                  },
                });
                yield* close;
                return;
              }
              if (phase === "rpc") {
                if (options.onRpcPreface !== undefined) {
                  const admitted = yield* Effect.exit(options.onRpcPreface());
                  if (Exit.isFailure(admitted)) {
                    const error = Cause.squash(admitted.cause);
                    yield* sendJson(
                      isStackError(error)
                        ? rpcPrefaceFailure(error)
                        : {
                            kind: "rpc-retiring",
                            stackId: options.stackId,
                            ownerSessionId: options.ownerSessionId,
                            error: {
                              tag: "StackStateInvalidError",
                              message: "RPC admission failed",
                            },
                          },
                    );
                    yield* close;
                    return;
                  }
                  rpcPrefaceLease = admitted.value;
                }
                yield* sendJson({
                  kind: "rpc-ready",
                  stackId: options.stackId,
                  ownerSessionId: options.ownerSessionId,
                });
              }
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
        yield* socket
          .runRaw(processChunk, { onOpen })
          .pipe(Effect.ensuring(releaseRpcPreface(true)));
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
      if (Socket.isCloseEvent(chunk)) return write(chunk);
      return encodeRawFrame(chunk).pipe(
        Effect.mapError(
          (error) =>
            new Socket.SocketError({
              reason: new Socket.SocketWriteError({ cause: new Error(error.message) }),
            }),
        ),
        Effect.flatMap(write),
        Effect.andThen(rpcMessageTag(chunk)),
        Effect.flatMap((tag) => {
          const response =
            phase === "rpc" &&
            firstRpcRequestSeen &&
            (tag === "Exit" || tag === "Chunk" || tag === "Defect");
          return response ? releaseRpcPreface(false) : Effect.void;
        }),
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
    let bound = false;
    if (options.endpoint.kind === "unix") {
      const endpoint = options.endpoint;
      const directory = controlDirectory(endpoint);
      yield* Effect.acquireRelease(
        ensurePrivateControlDirectory(fs, directory),
        (directoryCreated) =>
          (bound ? fs.remove(endpoint.path, { force: true }) : Effect.void).pipe(
            Effect.catchTag("PlatformError", () => Effect.void),
            Effect.andThen(
              directoryCreated
                ? fs.remove(directory, { force: true, recursive: true })
                : Effect.void,
            ),
            Effect.catchTag("PlatformError", () => Effect.void),
          ),
      );
    }
    const base = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const base = yield* restore(
          NodeSocketServer.make({ path: endpointPath(options.endpoint) }),
        );
        bound = true;
        return base;
      }),
    );
    if (options.endpoint.kind === "unix") {
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
    const completionRequests = new Set<string>();
    const startShutdown = (completion: Effect.Effect<void>) =>
      Effect.uninterruptible(
        FiberSet.run(completionFibers, completion, { startImmediately: true }).pipe(Effect.asVoid),
      );
    const patchedProtocol = RpcServer.Protocol.of({
      ...protocol,
      run: (handler) =>
        protocol.run((clientId, request) => {
          if (!Predicate.isTagged(request, "Request")) return handler(clientId, request);
          const key = `${clientId}:${String(request.id)}`;
          completionRequests.add(key);
          return handler(clientId, request).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const disconnected =
                  !(yield* protocol.clientIds).has(clientId) ||
                  (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
                if (!completionRequests.has(key) || !disconnected) return;
                completionRequests.delete(key);
                if (options.onShutdownReady !== undefined)
                  yield* startShutdown(options.onShutdownReady);
              }),
            ),
          );
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
    // Keeps handler defects as keyed Exit responses so lifecycle-completion state can be
    // cleaned by the same send path as typed failures; otherwise RpcServer emits a Defect
    // frame with no requestId for the terminal handoff.
    const rpcProgram: Effect.Effect<never, never> = RpcServer.make(StackRpcGroup, {
      disableTracing: true,
      disableFatalDefects: true,
      concurrency: MAINTENANCE_MAX_CONCURRENT_REQUESTS,
    }).pipe(
      Effect.provideService(RpcServer.Protocol, patchedProtocol),
      Effect.provide(StackRpcGroup.toLayer(options.rpcHandlers)),
    );
    yield* Effect.forkScoped(rpcProgram);
    return {
      endpoint: options.endpoint,
    } satisfies ControlServer;
  });

/** Client-side framed socket backed by the already-admitted control connection. */
const makeControlRpcSocket = (
  incoming: Queue.Dequeue<Uint8Array | string, Socket.SocketError>,
  write: (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>,
): Socket.Socket => {
  return Socket.make({
    runRaw: (handler, options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const decoder = new FrameDecoder();
          yield* options?.onOpen ?? Effect.void;
          yield* Stream.fromQueue(incoming).pipe(
            Stream.runForEach((chunk) =>
              decoder.push(toBytes(chunk), RPC_MAX_FRAME_BYTES).pipe(
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
            ),
          );
        }),
      ),
    writer: Effect.succeed((chunk: Uint8Array | string | Socket.CloseEvent) =>
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
        yield* write(encodedFrame);
      }),
    ),
  });
};

const isRpcAdmissionAck = (
  value: JsonValue,
  expected: { readonly stackId: string; readonly ownerSessionId: string },
): value is JsonValue & {
  readonly kind: "rpc-ready" | "rpc-retiring";
  readonly stackId: string;
  readonly ownerSessionId: string;
} => {
  if (!isJsonRecord(value)) return false;
  return (
    (value.kind === "rpc-ready" || value.kind === "rpc-retiring") &&
    value.stackId === expected.stackId &&
    value.ownerSessionId === expected.ownerSessionId
  );
};

const isJsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ControlClientOptions extends ControlIdentity {
  readonly rpcRelease?: string;
}

export interface ControlClient {
  readonly probe: Effect.Effect<MaintenanceResponse, Socket.SocketError | MaintenanceProtocolError>;
  readonly stop: Effect.Effect<MaintenanceResponse, Socket.SocketError | MaintenanceProtocolError>;
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
        // A connection can fail before NodeSocket runs the onOpen hook; join the reader
        // alongside writer readiness so failure can't strand this handshake on an unresolved
        // Deferred.
        const readerReady = Fiber.join(fiber).pipe(
          Effect.andThen(
            Effect.fail(
              new MaintenanceProtocolError({
                message: "Control connection closed",
                reason: "transport",
              }),
            ),
          ),
        );
        // NodeSocket opens its writer as part of runRaw's onOpen hook.
        const write = yield* Effect.raceFirst(Deferred.await(writerReady), readerReady);
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
        // The server closes a successful connection immediately after flushing its response;
        // check the response witness after the reader exits so the close event can't win
        // that race.
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
  const probe = maintenance("probe").pipe(
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
  );
  const stop = maintenance("stop");

  return {
    probe,
    stop,
    rpc: Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({
        path: endpointPath(endpoint),
        openTimeout: MAINTENANCE_REQUEST_DEADLINE_MS,
      });
      const incoming = yield* Queue.unbounded<Uint8Array | string, Socket.SocketError>();
      const opened = yield* Deferred.make<void, RpcClientError>();
      const write = yield* socket.writer;
      const frameDecoder = new FrameDecoder();
      let awaitingAdmission = true;
      const enqueue = (chunk: Uint8Array | string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const frames = yield* frameDecoder.push(toBytes(chunk), RPC_MAX_FRAME_BYTES).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Deferred.fail(
                  opened,
                  new RpcClientError({
                    reason: new RpcClientDefect({
                      message: `Invalid RPC admission response: ${error.message}`,
                      cause: error,
                    }),
                  }),
                ).pipe(Effect.as([])),
              onSuccess: Effect.succeed,
            }),
          );
          for (const frame of frames) {
            if (awaitingAdmission) {
              awaitingAdmission = false;
              const decoded = yield* Effect.exit(decodeFrame(frame));
              if (Exit.isFailure(decoded)) {
                yield* Deferred.fail(
                  opened,
                  new RpcClientError({
                    reason: new RpcClientDefect({
                      message: "RPC admission acknowledgement is invalid",
                      cause: Cause.squash(decoded.cause),
                    }),
                  }),
                );
                return;
              }
              if (
                !isRpcAdmissionAck(decoded.value, {
                  stackId: options.stackId,
                  ownerSessionId: options.ownerSessionId,
                })
              ) {
                yield* Deferred.fail(
                  opened,
                  new RpcClientError({
                    reason: new RpcClientDefect({
                      message: "RPC admission acknowledgement is missing",
                      cause: decoded.value,
                    }),
                  }),
                );
                return;
              }
              if (decoded.value.kind === "rpc-retiring") {
                yield* Deferred.fail(
                  opened,
                  new RpcClientError({
                    reason: new RpcClientDefect({
                      message: "Stack owner is retiring before RPC admission",
                      cause: decoded.value,
                    }),
                  }),
                );
                return;
              }
              yield* Deferred.succeed(opened, undefined);
              continue;
            }
            yield* Queue.offer(incoming, frame).pipe(Effect.asVoid);
          }
        });
      const preface = encodePreface({
        kind: "rpc",
        release: options.rpcRelease ?? STACK_RPC_RELEASE,
        stackId: options.stackId,
        ownerSessionId: options.ownerSessionId,
      });
      const open = write(preface).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Deferred.failCause(
              opened,
              Cause.map(cause, (error) => new RpcClientError({ reason: error.reason })),
            ).pipe(Effect.asVoid),
          onSuccess: () => Effect.void,
        }),
      );
      const reader: Effect.Effect<void, never, Scope.Scope> = socket
        .runRaw(enqueue, {
          onOpen: open,
        })
        .pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Deferred.failCause(
                opened,
                Cause.map(cause, (error) => new RpcClientError({ reason: error.reason })),
              ).pipe(Effect.andThen(Queue.failCause(incoming, cause)), Effect.asVoid),
            onSuccess: () =>
              Deferred.fail(
                opened,
                new RpcClientError({
                  reason: new RpcClientDefect({
                    message: "Control connection closed before RPC admission",
                    cause: new Error("Control socket closed before admission"),
                  }),
                }),
              ).pipe(
                Effect.asVoid,
                Effect.andThen(
                  Queue.fail(
                    incoming,
                    new Socket.SocketError({
                      reason: new Socket.SocketCloseError({ code: 1000 }),
                    }),
                  ),
                ),
                Effect.asVoid,
              ),
          }),
        );
      yield* Effect.forkScoped(reader);
      yield* Deferred.await(opened);
      const controlSocket = makeControlRpcSocket(incoming, write);
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

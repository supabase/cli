import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Layer } from "effect";
import {
  ProxyWebSocketConnector,
  ProxyWebSocketError,
  type ProxyWebSocket,
  type ProxyWebSocketConnectOptions,
} from "./ProxyWebSocket.ts";

const toBytes = (data: NodeWS.RawData): Uint8Array => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

const socketService = (socket: NodeWS.WebSocket): ProxyWebSocket => {
  type Message = Uint8Array | string;
  const messageListeners = new Set<(data: Message) => void>();
  const closeListeners = new Set<(code: number, reason: string) => void>();
  const errorListeners = new Set<(cause: unknown) => void>();
  const pendingMessages: Message[] = [];
  let closed: { readonly code: number; readonly reason: string } | undefined;
  let failed: unknown;

  socket.on("message", (data, isBinary) => {
    const message = isBinary ? toBytes(data) : data.toString();
    if (messageListeners.size === 0) {
      pendingMessages.push(message);
      return;
    }
    for (const listener of messageListeners) listener(message);
  });
  socket.on("close", (code, reason) => {
    closed = { code, reason: reason.toString() };
    for (const listener of closeListeners) listener(closed.code, closed.reason);
  });
  socket.on("error", (cause) => {
    failed = cause;
    for (const listener of errorListeners) listener(cause);
  });

  return {
    send: (data) =>
      Effect.callback<void, ProxyWebSocketError>((resume) => {
        try {
          socket.send(data, (cause) => {
            resume(
              cause
                ? Effect.fail(new ProxyWebSocketError({ operation: "send", cause }))
                : Effect.void,
            );
          });
        } catch (cause) {
          resume(Effect.fail(new ProxyWebSocketError({ operation: "send", cause })));
        }
      }),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => {
      messageListeners.add(listener);
      for (const message of pendingMessages.splice(0)) listener(message);
      return () => messageListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      if (closed !== undefined) listener(closed.code, closed.reason);
      return () => closeListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      if (failed !== undefined) listener(failed);
      return () => errorListeners.delete(listener);
    },
  };
};

const connect = (
  options: ProxyWebSocketConnectOptions,
): Effect.Effect<ProxyWebSocket, ProxyWebSocketError> =>
  Effect.try({
    try: () =>
      new NodeWS.WebSocket(options.url, [...(options.protocols ?? [])], {
        headers: { Host: options.host },
      }),
    catch: (cause) => new ProxyWebSocketError({ operation: "connect", cause }),
  }).pipe(
    Effect.flatMap((socket) =>
      Effect.callback<ProxyWebSocket, ProxyWebSocketError>((resume) => {
        const service = socketService(socket);
        const cleanup = () => {
          socket.off("open", onOpen);
          socket.off("error", onError);
        };
        const onOpen = () => {
          cleanup();
          resume(Effect.succeed(service));
        };
        const onError = (cause: Error) => {
          cleanup();
          resume(Effect.fail(new ProxyWebSocketError({ operation: "connect", cause })));
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
        return Effect.sync(() => {
          cleanup();
          // Aborting a CONNECTING ws emits error asynchronously. Keep a listener
          // installed until close so cancellation cannot become an unhandled event.
          const onAbortError = () => {};
          const onAbortClose = () => {
            socket.off("error", onAbortError);
          };
          socket.on("error", onAbortError);
          socket.once("close", onAbortClose);
          try {
            socket.close();
          } catch {
            socket.off("error", onAbortError);
            socket.off("close", onAbortClose);
          }
        });
      }),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new ProxyWebSocketError({
            operation: "connect",
            cause: new Error("Timed out connecting to Realtime WebSocket"),
          }),
        ),
    }),
  );

export const proxyWebSocketConnectorLayer: Layer.Layer<ProxyWebSocketConnector> = Layer.succeed(
  ProxyWebSocketConnector,
  { connect },
);

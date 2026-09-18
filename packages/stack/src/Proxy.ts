import { NodeSink, NodeSocket, NodeSocketServer, NodeStream } from "@effect/platform-node";
import { Data, Effect, Option, Stream } from "effect";
import type { Scope } from "effect";
import type { SocketServer } from "effect/unstable/socket";
import * as Net from "node:net";
import { PortError } from "./Ports.ts";

export type BackendAddress =
  | { readonly host: string; readonly port: number }
  | { readonly path: string };

export class ProxyError extends Data.TaggedError("ProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const proxyError = (cause: unknown) =>
  new ProxyError({ message: cause instanceof Error ? cause.message : String(cause), cause });

/** Binds a dedicated public listener and retains the socket until its scope closes. */
export const bindTcp = (host: string, port: number) =>
  NodeSocketServer.make({ host, port, allowHalfOpen: true }).pipe(
    Effect.mapError(
      (cause) => new PortError({ key: "tcp", message: "Cannot bind TCP listener", cause }),
    ),
  );

const connect = Effect.fn("Proxy.connect")((address: BackendAddress) =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.try({ try: () => new Net.Socket({ allowHalfOpen: true }), catch: proxyError }),
      (socket) =>
        Effect.sync(() => {
          socket.destroy();
        }),
    );
    yield* Effect.callback<void, ProxyError>((resume) => {
      const connected = () => resume(Effect.void);
      const failed = (cause: Error) => resume(Effect.fail(proxyError(cause)));
      socket.once("connect", connected);
      socket.once("error", failed);
      socket.connect(address);
      return Effect.sync(() => {
        socket.off("connect", connected);
        socket.off("error", failed);
      });
    }).pipe(Effect.timeout("10 seconds"), Effect.mapError(proxyError));
    return socket;
  }),
);

const copy = (source: Net.Socket, destination: Net.Socket) =>
  NodeStream.fromReadable({ evaluate: () => source, onError: proxyError, closeOnDone: false }).pipe(
    Stream.run(NodeSink.fromWritable({ evaluate: () => destination, onError: proxyError })),
  );

/** The scoped target acquisition owns request activity and performs orchestrated wake/readiness. */
export const serveTcp = Effect.fn("Proxy.serveTcp")(
  (
    listener: SocketServer.SocketServer["Service"],
    target: Effect.Effect<BackendAddress, ProxyError, Scope.Scope>,
  ) =>
    listener.run(() =>
      Effect.scoped(
        Effect.gen(function* () {
          // rc.112 supplies this service to handlers but does not remove it from run's requirements.
          const incoming = yield* Effect.serviceOption(NodeSocket.NetSocket).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(proxyError("TCP listener supplied no connection")),
                onSome: Effect.succeed,
              }),
            ),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              incoming.destroy();
            }),
          );
          const closed = Effect.callback<never, ProxyError>((resume) => {
            const onClose = () => resume(Effect.fail(proxyError("Public connection closed")));
            incoming.once("close", onClose);
            if (incoming.destroyed) onClose();
            return Effect.sync(() => {
              incoming.off("close", onClose);
            });
          });
          yield* Effect.gen(function* () {
            const address = yield* target;
            const backend = yield* connect(address);
            yield* Effect.all([copy(incoming, backend), copy(backend, incoming)], {
              concurrency: "unbounded",
              discard: true,
            });
          }).pipe(Effect.raceFirst(closed));
        }),
      ).pipe(Effect.catchTag("ProxyError", () => Effect.void)),
    ),
);

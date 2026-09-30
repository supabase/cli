import { NodeSink, NodeSocket, NodeSocketServer, NodeStream } from "@effect/platform-node";
import { Data, Duration, Effect, Option, Stream } from "effect";
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

/**
 * Safely above `ProcessRecipe`'s 60-second process-launch budget, so a wake that also has to
 * start a stopped prerequisite still has time to finish.
 */
export const wakeTimeout: Duration.Input = "120 seconds";

/** Bounds a proxy's wait for a lazy target so a stalled wake fails visibly instead of hanging. */
export const awaitWake = <A, R>(
  label: string,
  target: Effect.Effect<A, ProxyError, R>,
  timeout: Duration.Input = wakeTimeout,
): Effect.Effect<A, ProxyError, R> =>
  target.pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(new ProxyError({ message: `Wake for ${label} did not complete in time` })),
    }),
  );

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
    label: string,
    timeout: Duration.Input = wakeTimeout,
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
            const address = yield* awaitWake(label, target, timeout);
            const backend = yield* connect(address);
            yield* Effect.all([copy(incoming, backend), copy(backend, incoming)], {
              concurrency: "unbounded",
              discard: true,
            });
          }).pipe(
            Effect.tapError((cause) => Effect.logError(`Endpoint ${label} failed`, cause)),
            Effect.raceFirst(closed),
          );
        }),
      ).pipe(Effect.catchTag("ProxyError", () => Effect.void)),
    ),
);

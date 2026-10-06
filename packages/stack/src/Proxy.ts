import { NodeSink, NodeStream } from "@effect/platform-node";
import { Data, Effect, Exit, FiberSet, Scope, Stream } from "effect";
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

export interface TcpListener {
  readonly address: SocketServer.Address;
  /** Installs the per-connection handler; keeps the listener alive until interrupted. */
  readonly run: <R, E, _>(
    handler: (socket: Net.Socket) => Effect.Effect<_, E, R>,
  ) => Effect.Effect<never, never, R>;
}

/**
 * Binds a dedicated public listener and retains the socket until its scope closes, which also
 * destroys every established connection.
 */
export const bindTcp = (
  host: string,
  port: number,
): Effect.Effect<TcpListener, PortError, Scope.Scope> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    // Every accepted socket, queued or dispatched, from acceptance until close, so teardown
    // destroys all of them.
    const sockets = new Set<Net.Socket>();
    // A connection that arrives before `run` installs its handler is queued, the same as
    // `NodeSocketServer`'s own listener, so none are dropped in that gap.
    const pending = new Set<Net.Socket>();
    let onConnection: (conn: Net.Socket) => void = (conn) => {
      pending.add(conn);
    };
    const server = Net.createServer({ allowHalfOpen: true }, (conn) => {
      // Attached synchronously, before any dispatch, so a reset while a handler is still cold
      // (queued, or waiting on scoped target acquisition) never surfaces as an unhandled error.
      conn.on("error", () => conn.destroy());
      sockets.add(conn);
      conn.once("close", () => {
        sockets.delete(conn);
        pending.delete(conn);
      });
      onConnection(conn);
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, PortError>((resume) => {
        const onError = (cause: Error) =>
          // Unwrapped so `Ports.ts`'s conflict detection sees the same shape it gets from
          // `HttpProxy` (for example EADDRINUSE).
          resume(
            Effect.fail(new PortError({ key: "tcp", message: "Cannot bind TCP listener", cause })),
          );
        server.once("error", onError);
        server.listen(port, host, () => {
          // Accept errors after binding (for example fd exhaustion) are logged for the listener's
          // whole life rather than left unhandled to crash the owner.
          server.off("error", onError);
          server.on("error", (cause) =>
            Effect.runSyncWith(services)(Effect.logError("TCP listener error", cause)),
          );
          resume(Effect.void);
        });
        return Effect.sync(() => server.off("error", onError));
      }),
      () =>
        Effect.callback<void, never>((resume) => {
          pending.clear();
          for (const socket of sockets) socket.destroy();
          server.close(() => resume(Effect.void));
          return Effect.void;
        }),
    );
    const bound = server.address();
    if (bound === null)
      return yield* new PortError({ key: "tcp", message: "TCP listener has no address" });
    const address: SocketServer.Address =
      typeof bound === "string"
        ? { _tag: "UnixAddress", path: bound }
        : { _tag: "TcpAddress", hostname: bound.address, port: bound.port };

    const run = <R, E, _>(
      handler: (socket: Net.Socket) => Effect.Effect<_, E, R>,
    ): Effect.Effect<never, never, R> =>
      Effect.gen(function* () {
        const connectionScope = yield* Scope.make();
        const runFiber = yield* FiberSet.makeRuntime<R>().pipe(
          Effect.provideService(Scope.Scope, connectionScope),
        );
        const previous = onConnection;
        onConnection = (conn) => {
          runFiber(
            handler(conn).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Unhandled TCP connection failure", cause),
              ),
            ),
          );
        };
        for (const conn of pending) onConnection(conn);
        pending.clear();
        return yield* Effect.onExit(Effect.never, () =>
          Scope.close(connectionScope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                onConnection = previous;
              }),
            ),
          ),
        );
      });

    return {
      address,
      run,
    };
  });

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
    listener: TcpListener,
    target: Effect.Effect<BackendAddress, ProxyError, Scope.Scope>,
    label: string,
  ) =>
    listener.run((incoming) =>
      Effect.scoped(
        Effect.gen(function* () {
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
            const backend = yield* Effect.gen(function* () {
              const address = yield* target;
              return yield* connect(address);
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logError(`Endpoint ${label} failed: ${cause.message}`),
              ),
            );
            yield* Effect.all([copy(incoming, backend), copy(backend, incoming)], {
              concurrency: "unbounded",
              discard: true,
            });
          }).pipe(Effect.raceFirst(closed));
        }),
      ).pipe(Effect.catchTag("ProxyError", () => Effect.void)),
    ),
);

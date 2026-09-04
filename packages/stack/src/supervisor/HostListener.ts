import { Effect, Scope } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createNetServer, type Server as NetServer } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Duplex } from "node:stream";
import { PortUnavailableError } from "../public/Errors.ts";
import { type HostListener, type HostListenerConnections } from "../state/PortCoordinator.ts";
import { PORT_FIELD_PROTOCOL, type PortField } from "../public/Status.ts";

export interface HostListenerBindOptions {
  readonly createHttpServer?: () => HttpServer;
  readonly createTcpServer?: () => NetServer;
  /** Test/embedding seam for a foreign listener API; production uses Server.listen directly. */
  readonly listen?: (
    server: HttpServer | NetServer,
    address: string,
    port: number,
    onListening: () => void,
  ) => void;
}

interface ConnectionTracker extends HostListenerConnections {
  readonly detach: () => void;
  readonly close: () => void;
}

const trackConnections = (server: HttpServer | NetServer): ConnectionTracker => {
  const sockets = new Set<Duplex>();
  let closing = false;
  const onConnection = (socket: Duplex) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", onConnection);
  return {
    sockets,
    close: () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
    },
    detach: () => server.off("connection", onConnection),
  };
};

const closeServer = (
  server: HttpServer | NetServer,
  tracker: ConnectionTracker,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const finish = () => {
      tracker.detach();
      resume(Effect.void);
    };
    tracker.close();
    if (!server.listening) {
      finish();
      return;
    }
    server.close(finish);
    return Effect.sync(() => {
      tracker.close();
      tracker.detach();
      if (server.listening) server.close(() => undefined);
    });
  });

interface BoundServer<T extends HttpServer | NetServer> {
  readonly server: T;
  readonly connections: ConnectionTracker;
}

const bind = <T extends HttpServer | NetServer>(
  server: T,
  address: string,
  port: number,
  field: string,
  listen: HostListenerBindOptions["listen"] = (value, host, number, onListening) =>
    value.listen({ host, port: number }, onListening),
): Effect.Effect<BoundServer<T>, PortUnavailableError, Scope.Scope> =>
  Effect.callback<BoundServer<T>, PortUnavailableError>((resume) => {
    const tracker = trackConnections(server);
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
    };
    const teardown = () => {
      cleanup();
      tracker.close();
      tracker.detach();
      const swallow = () => undefined;
      server.once("error", swallow);
      try {
        server.close(() => server.off("error", swallow));
      } catch {
        server.off("error", swallow);
      }
    };
    const onError = (cause: Error) => {
      if (settled) return;
      settled = true;
      teardown();
      resume(
        Effect.fail(
          new PortUnavailableError({
            field,
            port,
            message: "Host listener is unavailable",
            cause,
          }),
        ),
      );
    };
    server.once("error", onError);
    try {
      listen(server, address, port, () => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(Effect.succeed({ server, connections: tracker }));
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      // `listen` may still be completing when the waiting fiber is interrupted. Keep a temporary
      // error sink while asking Node to close the exact server so a late bind failure cannot become
      // an uncaught process error. `close` throws synchronously when no handle exists; in that case
      // the server has no owned resources left to release.
      teardown();
    });
  });

/** Verifies an address/port can be bound without retaining a listener. */
export const checkHostPort = (
  address: string,
  port: number,
  field: string,
): Effect.Effect<void, PortUnavailableError> =>
  Effect.scoped(
    bind(createNetServer(), address, port, field).pipe(
      Effect.flatMap(({ server, connections }) => closeServer(server, connections)),
    ),
  );

/** Bind and retain one public host listener for direct adoption by a gateway. */
export const bindHostListener = (
  address: string,
  port: number,
  field: PortField,
): Effect.Effect<HostListener, PortUnavailableError, Scope.Scope> =>
  bindHostListenerWithOptions(address, port, field);

export const bindHostListenerWithOptions = (
  address: string,
  port: number,
  field: PortField,
  options: HostListenerBindOptions = {},
): Effect.Effect<HostListener, PortUnavailableError, Scope.Scope> => {
  if (PORT_FIELD_PROTOCOL[field] === "http")
    return bind(
      options.createHttpServer?.() ?? createHttpServer(),
      address,
      port,
      field,
      options.listen,
    ).pipe(
      Effect.flatMap(({ server, connections }) =>
        Effect.gen(function* () {
          const close = yield* Effect.cached(closeServer(server, connections));
          yield* Effect.addFinalizer(() => close);
          return {
            field,
            address,
            port,
            close,
            connections,
            binding: { kind: "http", server },
          } satisfies HostListener;
        }),
      ),
    );
  return bind(
    options.createTcpServer?.() ?? createNetServer({ allowHalfOpen: true }),
    address,
    port,
    field,
    options.listen,
  ).pipe(
    Effect.flatMap(({ server, connections }) =>
      Effect.gen(function* () {
        const close = yield* Effect.cached(closeServer(server, connections));
        yield* Effect.addFinalizer(() => close);
        return {
          field,
          address,
          port,
          close,
          connections,
          binding: { kind: "tcp", server, allowHalfOpen: true },
        } satisfies HostListener;
      }),
    ),
  );
};

export const isHttpPortField = (field: PortField): boolean => PORT_FIELD_PROTOCOL[field] === "http";

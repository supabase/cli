import { Effect, Queue, Scope } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createNetServer, isIP, type Server as NetServer } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import type { Duplex } from "node:stream";
import { PortUnavailableError } from "../public/Errors.ts";
import { PORT_FIELD_PROTOCOL, type PortField } from "../public/Status.ts";

export interface HostListener {
  readonly field: PortField;
  readonly address: string;
  readonly port: number;
  readonly close: Effect.Effect<void>;
  /** The exact bound listener may be adopted by a gateway without rebind. */
  readonly binding: HostListenerBinding;
  /** Sockets accepted since bind, shared with an adopting gateway for teardown. */
  readonly connections: HostListenerConnections;
}

interface HostListenerConnections {
  readonly sockets: Set<Duplex>;
  /** Release the pre-adoption connection capture without resuming socket reads. */
  readonly release?: () => void;
}

export type HostListenerHttpEvent =
  | {
      readonly _tag: "request";
      readonly request: import("node:http").IncomingMessage;
      readonly response: import("node:http").ServerResponse;
    }
  | {
      readonly _tag: "upgrade";
      readonly request: import("node:http").IncomingMessage;
      readonly socket: Duplex;
      readonly head: Buffer;
    };

export interface HostListenerHttpEvents {
  readonly queue: Queue.Queue<HostListenerHttpEvent>;
  /** Stop capturing events; queued events remain available for gateway adoption. */
  readonly detach: () => void;
}

type HostListenerBinding =
  | {
      readonly kind: "http";
      readonly server: HttpServer;
      readonly pendingEvents?: HostListenerHttpEvents;
    }
  | { readonly kind: "tcp"; readonly server: NetServer; readonly allowHalfOpen: true };

/** A scoped TCP reservation used while selecting a durable workload port. */
export interface HeldPort {
  readonly port: number;
  readonly close: Effect.Effect<void>;
}

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
}

const trackConnections = (
  server: HttpServer | NetServer,
  holdConnections: boolean,
): ConnectionTracker => {
  const sockets = new Set<Duplex>();
  const errorListeners = new Map<Duplex, (cause: Error) => void>();
  let holding = true;
  const onConnection = (socket: Duplex) => {
    sockets.add(socket);
    const onError = (_cause: Error) => {
      // A held socket has no gateway-owned error listener yet. Destroy only this exact socket so
      // its error cannot become an uncaught event or affect other connections awaiting adoption.
      socket.destroy();
    };
    const onClose = () => {
      sockets.delete(socket);
      errorListeners.delete(socket);
    };
    errorListeners.set(socket, onError);
    // TCP bytes must stay buffered until the gateway has connected its tunnel. HTTP request events
    // are captured separately because Node/Bun parse them despite a paused socket.
    if (holding && holdConnections) socket.pause();
    socket.once("close", onClose);
    socket.once("error", onError);
  };
  server.on("connection", onConnection);
  const release = () => {
    if (!holding) return;
    holding = false;
    server.off("connection", onConnection);
    // Gateway adoption takes ownership of post-adoption socket errors. Keep close tracking until
    // each socket closes so the exact resource set remains available to shutdown.
    for (const [socket, onError] of errorListeners) socket.off("error", onError);
  };
  return {
    sockets,
    release,
    detach: () => {
      release();
    },
  };
};

const closeServer = (
  server: HttpServer | NetServer,
  tracker: ConnectionTracker,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const destroyConnections = () => {
      for (const socket of tracker.sockets) socket.destroy();
    };
    const finish = () => {
      tracker.detach();
      resume(Effect.void);
    };
    destroyConnections();
    if (!server.listening) {
      finish();
      return;
    }
    server.close(finish);
    return Effect.sync(() => {
      destroyConnections();
      tracker.detach();
      if (server.listening) server.close(() => undefined);
    });
  });

interface BoundServer<T extends HttpServer | NetServer> {
  readonly server: T;
  readonly connections: ConnectionTracker;
  readonly pendingEvents?: HostListenerHttpEvents;
}

const captureHttpEvents = (
  server: HttpServer,
  queue: Queue.Queue<HostListenerHttpEvent>,
): HostListenerHttpEvents => {
  const requestHandler = (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    Queue.offerUnsafe(queue, { _tag: "request", request, response });
  };
  const upgradeHandler = (
    request: import("node:http").IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    socket.pause();
    Queue.offerUnsafe(queue, { _tag: "upgrade", request, socket, head });
  };
  server.on("request", requestHandler);
  server.on("upgrade", upgradeHandler);
  return {
    queue,
    detach: () => {
      server.off("request", requestHandler);
      server.off("upgrade", upgradeHandler);
    },
  };
};

const configureHttpTimeouts = (server: HttpServer): void => {
  // A request can legitimately wait for a cold workload to become ready. Keep the native
  // listener from terminating that request while the queue or lazy activation owns it.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
};

const bind = <T extends HttpServer | NetServer>(
  server: T,
  address: string,
  port: number,
  field: string,
  listen: HostListenerBindOptions["listen"] = (value, host, number, onListening) =>
    value.listen(
      isIP(host) === 6 ? { host, port: number, ipv6Only: false } : { host, port: number },
      onListening,
    ),
  holdConnections = false,
  prepare?: (server: T) => HostListenerHttpEvents,
): Effect.Effect<BoundServer<T>, PortUnavailableError, Scope.Scope> =>
  Effect.callback<BoundServer<T>, PortUnavailableError>((resume) => {
    const tracker = trackConnections(server, holdConnections);
    const pendingEvents = prepare?.(server);
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
    };
    const teardown = () => {
      cleanup();
      pendingEvents?.detach();
      tracker.detach();
      const swallow = () => undefined;
      server.once("error", swallow);
      try {
        for (const socket of tracker.sockets) socket.destroy();
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
        resume(Effect.succeed({ server, connections: tracker, pendingEvents }));
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      // `listen` may still be completing when the fiber is interrupted. Close the server with a
      // temporary error sink so a late bind failure can't become an uncaught process error;
      // `close` throws synchronously if no handle exists, meaning there's nothing left to release.
      teardown();
    });
  });

/** Verifies an address/port can be bound without retaining a listener. */
export const checkHostPort = (
  address: string,
  port: number,
  field: string,
): Effect.Effect<void, PortUnavailableError> =>
  Effect.scoped(bindHeldPort(address, port, field).pipe(Effect.asVoid));

/** Bind and retain one TCP port until its enclosing scope is closed. */
export const bindHeldPort = (
  address: string,
  port: number,
  field: string,
): Effect.Effect<HeldPort, PortUnavailableError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const server = createNetServer({ allowHalfOpen: true });
      const bound = yield* restore(bind(server, address, port, field, undefined, true));
      const close = yield* Effect.cached(closeServer(bound.server, bound.connections));
      yield* Effect.addFinalizer(() => close);
      return { port: boundPort(bound.server, port), close } satisfies HeldPort;
    }),
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
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<HostListenerHttpEvent>();
        const server = options.createHttpServer?.() ?? createHttpServer();
        configureHttpTimeouts(server);
        const bound = yield* restore(
          bind(server, address, port, field, options.listen, false, (server) =>
            captureHttpEvents(server, queue),
          ),
        );
        const close = yield* Effect.cached(
          Effect.sync(() => bound.pendingEvents?.detach()).pipe(
            Effect.andThen(
              bound.pendingEvents === undefined
                ? Effect.void
                : Queue.shutdown(bound.pendingEvents.queue),
            ),
            Effect.andThen(closeServer(bound.server, bound.connections)),
          ),
        );
        yield* Effect.addFinalizer(() => close);
        return {
          field,
          address: boundAddress(bound.server, address),
          port: boundPort(bound.server, port),
          close,
          connections: bound.connections,
          binding: { kind: "http", server: bound.server, pendingEvents: bound.pendingEvents },
        } satisfies HostListener;
      }),
    );
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const server = options.createTcpServer?.() ?? createNetServer({ allowHalfOpen: true });
      const bound = yield* restore(bind(server, address, port, field, options.listen, true));
      const close = yield* Effect.cached(closeServer(bound.server, bound.connections));
      yield* Effect.addFinalizer(() => close);
      return {
        field,
        address: boundAddress(bound.server, address),
        port: boundPort(bound.server, port),
        close,
        connections: bound.connections,
        binding: { kind: "tcp", server: bound.server, allowHalfOpen: true },
      } satisfies HostListener;
    }),
  );
};

export const isHttpPortField = (field: PortField): boolean => PORT_FIELD_PROTOCOL[field] === "http";

const boundAddress = (server: HttpServer | NetServer, fallback: string): string => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.address : fallback;
};

const boundPort = (server: HttpServer | NetServer, fallback: number): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : fallback;
};

const isIpv4 = (address: string): boolean => isIP(address) === 4;
const isIpv6 = (address: string): boolean => isIP(address) === 6;

/** Whether a bound listener is known to cover an internal bind address. */
export const hostListenerCoversAddress = (listener: HostListener, address: string): boolean => {
  if (listener.address === address) return true;
  if (listener.address === "0.0.0.0" && isIpv4(address)) return true;
  // IPv6 wildcard listeners are dual-stack in bind().
  if (listener.address === "::" && (isIpv6(address) || isIpv4(address))) return true;
  return false;
};

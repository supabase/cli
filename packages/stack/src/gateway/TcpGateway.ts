import { Effect, Exit, FiberSet, Scope } from "effect";
import { createServer, Socket, type Server } from "node:net";
import type { Fiber } from "effect/Fiber";
import { GatewayActivationError } from "../public/Errors.ts";
import type {
  ActivationResult,
  BackendEndpoint,
  GatewayRoute,
  GatewayRouteRequest,
  LazyActivator,
} from "./Gateway.ts";
import type { HostListener } from "../state/PortCoordinator.ts";

export interface TcpGatewayOptions {
  readonly address?: string;
  readonly port?: number;
  readonly listener?: HostListener;
  readonly routes: ReadonlyArray<GatewayRoute>;
  readonly activate: LazyActivator["activate"];
  readonly resolveBackend?: (
    route: GatewayRoute,
    request: GatewayRouteRequest,
    activation: ActivationResult,
  ) => Effect.Effect<BackendEndpoint, GatewayActivationError>;
}

export interface TcpGateway {
  readonly address: string;
  readonly port: number;
  readonly close: Effect.Effect<void>;
  readonly server: Server;
}

const routeFor = (routes: ReadonlyArray<GatewayRoute>): GatewayRoute | undefined =>
  routes.find((route) => route.match({ path: "/", headers: {} }));

const tunnel = (
  source: Socket,
  backend: BackendEndpoint,
): Effect.Effect<void, GatewayActivationError> =>
  Effect.callback<void, GatewayActivationError>((resume) => {
    const target = new Socket();
    let settled = false;
    let targetEnded = false;
    const onSourceError = (cause: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      source.destroy();
      target.destroy();
      resume(Effect.fail(new GatewayActivationError({ message: "Gateway backend failed", cause })));
    };
    const onTargetError = (cause: Error) => onSourceError(cause);
    const onSourceClose = () => {
      target.destroy();
      if (!settled) {
        settled = true;
        cleanup();
        resume(Effect.void);
      }
    };
    const onTargetClose = () => {
      if (!settled) {
        if (!targetEnded) {
          settled = true;
          cleanup();
          source.destroy();
          resume(Effect.void);
        }
      }
    };
    const onSourceEnd = () => target.end();
    const onTargetEnd = () => {
      targetEnded = true;
      source.end();
    };
    const onConnect = () => {
      // Node's pipe implementation naturally propagates backpressure. Keeping
      // both streams open here preserves protocol half-close semantics.
      source.pipe(target, { end: false });
      target.pipe(source, { end: false });
    };
    const cleanup = () => {
      source.off("error", onSourceError);
      target.off("error", onTargetError);
      source.off("close", onSourceClose);
      target.off("close", onTargetClose);
      target.off("connect", onConnect);
      source.off("end", onSourceEnd);
      target.off("end", onTargetEnd);
    };
    source.once("error", onSourceError);
    target.once("error", onTargetError);
    source.once("close", onSourceClose);
    target.once("close", onTargetClose);
    source.once("end", onSourceEnd);
    target.once("end", onTargetEnd);
    target.once("connect", onConnect);
    target.connect(backend.port, backend.host);
    return Effect.sync(() => {
      if (!settled) settled = true;
      cleanup();
      source.destroy();
      target.destroy();
    });
  });

const handleConnection = (
  source: Socket,
  options: TcpGatewayOptions,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber<A, E>,
  active: Set<Socket>,
): void => {
  active.add(source);
  source.once("close", () => active.delete(source));
  const route = routeFor(options.routes);
  if (route === undefined) {
    source.destroy();
    return;
  }
  const view: GatewayRouteRequest = { path: "/", headers: {} };
  const operation = options.activate(route.capability).pipe(
    Effect.flatMap((result) =>
      options.resolveBackend === undefined
        ? Effect.succeed(result.endpoint)
        : options.resolveBackend(route, view, result),
    ),
    Effect.flatMap((backend) => tunnel(source, backend)),
  );
  // Node invokes this handler outside Effect; use the owner-scoped FiberSet
  // runtime for the exact accepted connection's lifecycle.
  const fiber = runFork(operation);
  fiber.addObserver((exit) => {
    if (Exit.isFailure(exit)) source.destroy();
  });
};

/** Start a transparent TCP gateway, optionally adopting an already-bound server. */
export const makeTcpGateway = (
  options: TcpGatewayOptions,
): Effect.Effect<TcpGateway, GatewayActivationError, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<unknown, unknown>();
    const runFork = yield* FiberSet.runtime(fibers)<never>();
    if (options.listener?.binding?.kind === "http")
      return yield* new GatewayActivationError({ message: "Gateway listener protocol mismatch" });
    if (
      options.listener?.binding?.kind === "tcp" &&
      options.listener.binding.allowHalfOpen !== true
    )
      return yield* new GatewayActivationError({
        message: "Gateway listener must preserve half-close",
      });
    const server =
      options.listener?.binding?.kind === "tcp"
        ? options.listener.binding.server
        : createServer({ allowHalfOpen: true });
    if (options.listener !== undefined && !server.listening)
      return yield* new GatewayActivationError({ message: "Gateway listener is not bound" });
    const active = new Set<Socket>();
    const connectionHandler = (socket: Socket) =>
      handleConnection(socket, options, runFork, active);
    server.on("connection", connectionHandler);
    if (!server.listening) {
      yield* Effect.callback<void, GatewayActivationError>((resume) => {
        let settled = false;
        const cleanup = () => {
          server.off("error", onError);
          server.close(() => undefined);
        };
        const onError = (cause: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(
            Effect.fail(
              new GatewayActivationError({ message: "Gateway listener unavailable", cause }),
            ),
          );
        };
        server.once("error", onError);
        server.listen({ host: options.address ?? "127.0.0.1", port: options.port ?? 0 }, () => {
          if (settled) return;
          settled = true;
          server.off("error", onError);
          resume(Effect.void);
        });
        return Effect.sync(() => {
          if (settled) return;
          settled = true;
          cleanup();
        });
      });
    }
    const address = server.address();
    if (typeof address !== "object" || address === null)
      return yield* new GatewayActivationError({
        message: "Gateway listener did not expose an endpoint",
      });
    const closeOperation = Effect.gen(function* () {
      server.off("connection", connectionHandler);
      yield* FiberSet.clear(fibers);
      for (const socket of active) socket.destroy();
      if (options.listener !== undefined) yield* options.listener.close;
      yield* Effect.callback<void>((resume) => {
        if (!server.listening) return resume(Effect.void);
        server.close(() => resume(Effect.void));
      });
    });
    const close = yield* Effect.cached(closeOperation);
    yield* Effect.addFinalizer(() => close);
    return { address: address.address, port: address.port, close, server } satisfies TcpGateway;
  });

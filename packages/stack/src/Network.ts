import {
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { DOCKER_HOST_ALIAS } from "./runtime/Container.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { makePorts, PortError, probeVacant } from "./Ports.ts";
import { bindTcp, serveTcp, type BackendAddress, type ProxyError } from "./Proxy.ts";
import { makeHttpProxy, type HttpProxy, type HttpRoute } from "./HttpProxy.ts";

export type NetworkRuntime = "native" | "docker";

/**
 * The shutdown-drain deadline: in-flight HTTP work keeps flowing until this event completes.
 * An event rather than a duration so a test can gate exactly when it fires.
 */
export const ShutdownDrainDeadline = Context.Reference<Effect.Effect<void>>(
  "@supabase/stack/ShutdownDrainDeadline",
  { defaultValue: () => Effect.sleep("10 seconds") },
);

/** What shutdown drain needs from a listener: stop accepting, and for HTTP, the in-flight work to wait on. */
interface ListenerHandle {
  readonly stopAccepting: Effect.Effect<void>;
  readonly outstandingConnections?: SubscriptionRef.SubscriptionRef<number>;
}

type RouteContribution = Pick<
  HttpRoute,
  "prefix" | "upstreamPrefix" | "upstreamHost" | "keyRewrite"
>;

export interface NetworkEndpoint {
  readonly protocol: "tcp" | "http";
  readonly port: number | "auto";
  readonly backend: Effect.Effect<BackendAddress, ProxyError, Scope.Scope>;
  readonly shared?: ReadonlyArray<RouteContribution>;
  /**
   * Routes a dedicated endpoint additionally contributes to the shared API listener, without
   * claiming the shared port itself. Installed when the shared listener exists, queued otherwise.
   */
  readonly join?: ReadonlyArray<RouteContribution>;
  readonly enabled: Effect.Effect<boolean>;
}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface NetworkBinding {
  readonly name: string;
  readonly protocol: "tcp" | "http";
  readonly host: string;
  readonly port: number;
}

export interface NetworkNamespace {
  readonly bindings: Effect.Effect<ReadonlyArray<NetworkBinding>>;
  readonly bind: Effect.Effect<ReadonlyArray<NetworkBinding>, NetworkError>;
  readonly close: Effect.Effect<void, NetworkError>;
  /** Closes the endpoints for good once the instance is stopped; saved port assignments stay. */
  readonly release: Effect.Effect<void, NetworkError>;
  /** Deletes the saved port assignments of this instance's dedicated endpoints. */
  readonly releasePorts: Effect.Effect<void, NetworkError>;
  readonly address: (
    name: string,
    from: "host" | "runtime",
  ) => Effect.Effect<NetworkBinding, NetworkError>;
}

export interface Interface {
  /** Releases every reservation this stack holds, dedicated and shared alike, in one step. */
  readonly releaseStack: Effect.Effect<void, NetworkError>;
  readonly register: (options: {
    readonly id: string;
    readonly endpoints: Readonly<Record<string, NetworkEndpoint>>;
  }) => Effect.Effect<NetworkNamespace, NetworkError>;
  /**
   * Shutdown drain, one-way: closes accept on every stack listener, public and dependency alike,
   * then waits until in-flight HTTP requests and upgraded sockets settle or `ShutdownDrainDeadline`
   * elapses, whichever comes first. TCP connections are never waited on. Established connections
   * stay open and listener scopes are untouched; the caller stops the services and closes the
   * scopes afterward, which destroys whatever remains.
   */
  readonly drain: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/Network") {}

const errorFor = (operation: string, cause: unknown) =>
  new NetworkError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const makeNetwork = (options: {
  readonly stackId: string;
  readonly runtime: NetworkRuntime;
  readonly state: StackNamespace.Interface;
  readonly platform?: NodeJS.Platform;
}) =>
  Effect.gen(function* () {
    const ports = yield* makePorts(options.state).pipe(
      Effect.mapError((cause) => errorFor("ports", cause)),
    );
    const probe = probeVacant(options.platform ?? process.platform);
    const owner = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    // Set once under `gate` by `drain`, before it snapshots `listeners`, and never cleared; checked
    // under the same gate by `bind`, so a bind that hasn't yet acquired the gate when drain starts
    // either completes before drain's snapshot (and so is captured by it) or observes this and
    // refuses outright so neither slips a new, untracked listener past both the snapshot and the
    // accept cut.
    const draining = yield* Ref.make(false);
    // Every bound listener (the shared API proxy under "api", every dedicated endpoint under
    // "id:name"), tracked only for shutdown drain; registration and deregistration are tied to the
    // same scope that owns the listener, so this never drifts from what is actually bound.
    const listeners = yield* Ref.make<ReadonlyMap<string, ListenerHandle>>(new Map());
    const trackListener = (key: string, handle: ListenerHandle) =>
      Ref.update(listeners, (current) => new Map(current).set(key, handle)).pipe(
        Effect.andThen(
          Effect.addFinalizer(() =>
            Ref.update(listeners, (current) => {
              if (current.get(key) !== handle) return current;
              const next = new Map(current);
              next.delete(key);
              return next;
            }),
          ),
        ),
      );
    const shared = yield* Ref.make<
      | {
          readonly claim: number;
          readonly proxy: HttpProxy;
          readonly routes: ReadonlyArray<HttpRoute>;
          readonly scope: Scope.Closeable;
        }
      | undefined
    >(undefined);
    // Join routes queued before any claiming endpoint has created the shared listener.
    const pendingJoins = yield* Ref.make<ReadonlyArray<HttpRoute>>([]);

    const listenHost = options.runtime === "native" ? "127.0.0.1" : "0.0.0.0";
    const hostAddress = "127.0.0.1";
    const runtimeAddress = options.runtime === "native" ? "127.0.0.1" : DOCKER_HOST_ALIAS;

    const routeKey = (route: Pick<HttpRoute, "id" | "prefix">) => `${route.id}:${route.prefix}`;

    /** Maps one endpoint's route contributions to the shared listener's `HttpRoute` shape. */
    const toHttpRoutes = (
      id: string,
      contributions: ReadonlyArray<RouteContribution>,
      backend: NetworkEndpoint["backend"],
    ): ReadonlyArray<HttpRoute> =>
      contributions.map((route) => ({
        id,
        prefix: route.prefix,
        upstreamPrefix: route.upstreamPrefix,
        upstreamHost: route.upstreamHost,
        ...(route.keyRewrite === undefined ? {} : { keyRewrite: route.keyRewrite }),
        target: backend,
      }));

    /** Installs a namespace's joined routes onto the shared listener, or queues them if it does not exist yet. */
    const installJoin = Effect.fn("Network.installJoin")(function* (
      routeId: string,
      join: NonNullable<NetworkEndpoint["join"]>,
      backend: NetworkEndpoint["backend"],
    ) {
      const routes = toHttpRoutes(routeId, join, backend);
      const ownKeys = new Set(routes.map(routeKey));
      const current = yield* Ref.get(shared);
      if (current === undefined) {
        yield* Ref.update(pendingJoins, (existing) => [
          ...existing.filter((route) => !ownKeys.has(routeKey(route))),
          ...routes,
        ]);
        return;
      }
      const next = [...current.routes.filter((route) => !ownKeys.has(routeKey(route))), ...routes];
      yield* current.proxy.setRoutes(next);
      yield* Ref.set(shared, { ...current, routes: next });
    });

    const register = Effect.fn("Network.register")(function* ({
      id,
      endpoints,
    }: {
      readonly id: string;
      readonly endpoints: Readonly<Record<string, NetworkEndpoint>>;
    }) {
      const bound = yield* Ref.make<Map<string, NetworkBinding>>(new Map());
      const scopes = yield* Ref.make<Map<string, Scope.Closeable>>(new Map());
      const closed = yield* Ref.make(false);

      const bind = Effect.fn("Network.bind")(() =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            if (yield* Ref.get(closed))
              return yield* errorFor("bind", "Network namespace is closed");
            if (yield* Ref.get(draining)) return yield* errorFor("bind", "Network is draining");
            for (const [name, endpoint] of Object.entries(endpoints)) {
              if ((yield* Ref.get(bound)).has(name)) continue;
              yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const endpointScope = yield* Scope.fork(owner, "sequential");
                  const key = endpoint.shared === undefined ? `${id}:${name}` : "api";
                  const result = yield* restore(
                    ports
                      .acquire<{ readonly proxy?: HttpProxy }, Scope.Scope>(
                        { stackId: options.stackId, key, host: listenHost, port: endpoint.port },
                        (host, port) =>
                          Effect.gen(function* () {
                            if (endpoint.shared !== undefined) {
                              const current = yield* Ref.get(shared);
                              if (current !== undefined) {
                                if (current.claim !== port)
                                  return yield* new PortError({
                                    key: "api",
                                    message: "Shared API port differs from existing claim",
                                  });
                                return { proxy: current.proxy };
                              }
                              yield* probe(key, host, port);
                              const proxy = yield* makeHttpProxy({ host, port });
                              yield* trackListener(key, proxy);
                              return { proxy };
                            }
                            if (endpoint.protocol === "http") {
                              yield* probe(key, host, port);
                              const proxy = yield* makeHttpProxy({ host, port });
                              yield* proxy.setRoutes([
                                { id, prefix: "/", target: endpoint.backend },
                              ]);
                              yield* trackListener(key, proxy);
                              return { proxy };
                            }
                            yield* probe(key, host, port);
                            const listener = yield* bindTcp(host, port);
                            yield* trackListener(key, { stopAccepting: listener.stopAccepting });
                            yield* Effect.forkIn(
                              serveTcp(listener, endpoint.backend, `${id}:${name}`).pipe(
                                Effect.provideService(Scope.Scope, endpointScope),
                              ),
                              endpointScope,
                              { startImmediately: true },
                            );
                            return {};
                          }),
                      )
                      .pipe(
                        Effect.provideService(Scope.Scope, endpointScope),
                        Effect.mapError((cause) => errorFor("bind", cause)),
                      ),
                  ).pipe(
                    Effect.onExit((exit) =>
                      Exit.isFailure(exit) ? Scope.close(endpointScope, exit) : Effect.void,
                    ),
                  );
                  if (endpoint.shared !== undefined && result.listener.proxy !== undefined) {
                    const previous = yield* Ref.get(shared);
                    let seeded: ReadonlyArray<HttpRoute> = [];
                    if (previous === undefined) seeded = yield* Ref.get(pendingJoins);
                    const current = previous ?? {
                      claim: result.port,
                      proxy: result.listener.proxy,
                      routes: seeded,
                      scope: endpointScope,
                    };
                    if (previous !== undefined) yield* Scope.close(endpointScope, Exit.void);
                    else if (seeded.length > 0) yield* Ref.set(pendingJoins, []);
                    const routes = [
                      ...current.routes,
                      ...toHttpRoutes(id, endpoint.shared, endpoint.backend),
                    ];
                    yield* current.proxy.setRoutes(routes);
                    yield* Ref.set(shared, { ...current, routes });
                  } else {
                    yield* Ref.update(scopes, (current) =>
                      new Map(current).set(name, endpointScope),
                    );
                  }
                  if (endpoint.join !== undefined)
                    yield* installJoin(id, endpoint.join, endpoint.backend);
                  yield* Ref.update(bound, (current) =>
                    new Map(current).set(name, {
                      name,
                      protocol: endpoint.protocol,
                      host: hostAddress,
                      port: result.port,
                    }),
                  );
                }),
              );
            }
            return [...(yield* Ref.get(bound)).values()];
          }),
        ),
      );

      const close = Effect.fn("Network.close")(() =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            if (yield* Ref.get(closed)) return;
            for (const endpoint of Object.values(endpoints)) if (yield* endpoint.enabled) return;

            // Drop this namespace's queued join routes so a later listener never resurrects them.
            yield* Ref.update(pendingJoins, (routes) => routes.filter((route) => route.id !== id));

            const current = yield* Ref.get(shared);
            let remainingRoutes = current?.routes ?? [];
            if (current !== undefined) {
              remainingRoutes = current.routes.filter((route) => route.id !== id);
              yield* Ref.set(shared, { ...current, routes: remainingRoutes });
              yield* current.proxy
                .setRoutes(remainingRoutes)
                .pipe(Effect.mapError((cause) => errorFor("close", cause)));
              if (remainingRoutes.length === 0) {
                yield* Scope.close(current.scope, Exit.void);
                yield* Ref.set(shared, undefined);
              }
            }
            for (const [name, scope] of yield* Ref.get(scopes)) {
              const endpoint = endpoints[name];
              if (endpoint?.shared !== undefined) continue;
              yield* Scope.close(scope, Exit.void).pipe(
                Effect.mapError((cause) => errorFor("close", cause)),
              );
            }
            yield* Ref.set(bound, new Map());
            yield* Ref.set(scopes, new Map());
          }),
        ),
      );
      const release = Effect.fn("Network.release")(() =>
        close().pipe(
          Effect.andThen(
            Effect.gen(function* () {
              for (const endpoint of Object.values(endpoints))
                if (yield* endpoint.enabled)
                  return yield* errorFor(
                    "release",
                    "Stop the instance before releasing its endpoints",
                  );
              yield* Ref.set(closed, true);
            }),
          ),
        ),
      );
      const releasePorts = Effect.fn("Network.releasePorts")(() =>
        Effect.forEach(
          Object.entries(endpoints).filter(([, endpoint]) => endpoint.shared === undefined),
          ([name]) =>
            ports
              .release(options.stackId, `${id}:${name}`)
              .pipe(Effect.mapError((cause) => errorFor("release", cause))),
          { discard: true },
        ),
      );
      const address = Effect.fn("Network.address")((name: string, from: "host" | "runtime") =>
        Effect.gen(function* () {
          const endpoint = endpoints[name];
          if (endpoint === undefined) return yield* errorFor("address", `Unknown endpoint ${name}`);
          const key = endpoint.shared === undefined ? `${id}:${name}` : "api";
          const port = yield* ports
            .assigned(options.stackId, key)
            .pipe(Effect.mapError((cause) => errorFor("address", cause)));
          if (port === undefined)
            return yield* errorFor("address", `Endpoint ${name} is not assigned`);
          return {
            name,
            protocol: endpoint.protocol,
            host: from === "host" ? hostAddress : runtimeAddress,
            port,
          };
        }),
      );
      return {
        bind: bind(),
        close: close(),
        release: release(),
        releasePorts: releasePorts(),
        address,
        bindings: Ref.get(bound).pipe(Effect.map((values) => [...values.values()])),
      } satisfies NetworkNamespace;
    });

    const releaseStack = Effect.fn("Network.releaseStack")(() =>
      ports
        .releaseStack(options.stackId)
        .pipe(Effect.mapError((cause) => errorFor("release", cause))),
    );
    // Stopping accepting can only shrink each HTTP listener's outstanding count from here on, so
    // waiting for every handle to independently reach 0 is equivalent to waiting for the total.
    const quiesced = (count: SubscriptionRef.SubscriptionRef<number>) =>
      SubscriptionRef.changes(count).pipe(
        Stream.takeUntil((outstanding) => outstanding === 0),
        Stream.runDrain,
      );
    const drain = Effect.fn("Network.drain")(function* () {
      const deadline = yield* ShutdownDrainDeadline;
      // Setting `draining` and snapshotting `listeners` atomically under the same gate `bind`
      // holds for its whole call means no bind can complete after this snapshot without either
      // being captured by it or observing `draining` and refusing before creating anything.
      const handles = yield* gate.withPermits(1)(
        Ref.set(draining, true).pipe(
          Effect.andThen(Ref.get(listeners)),
          Effect.map((current) => [...current.values()]),
        ),
      );
      yield* Effect.forEach(handles, (handle) => handle.stopAccepting, { discard: true });
      const inFlight = handles.flatMap((handle) =>
        handle.outstandingConnections === undefined ? [] : [handle.outstandingConnections],
      );
      const outcome = yield* Effect.forEach(inFlight, quiesced, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.as("quiesced" as const),
        Effect.race(deadline.pipe(Effect.as("deadline" as const))),
      );
      yield* Effect.annotateCurrentSpan({ listeners: handles.length, outcome });
    });
    return {
      register,
      releaseStack: releaseStack(),
      drain: drain(),
    } satisfies Interface;
  });

export const layer = (options: { readonly stackId: string; readonly runtime: NetworkRuntime }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* StackNamespace.Service;
      return yield* makeNetwork({ ...options, state });
    }).pipe(Effect.map(Service.of)),
  ).pipe(Layer.provide(PortReservations.layer));

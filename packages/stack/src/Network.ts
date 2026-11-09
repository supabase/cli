import { Context, Data, Effect, Exit, Layer, Ref, Scope, Semaphore } from "effect";
import { DOCKER_HOST_ALIAS } from "./runtime/Container.ts";
import {
  apiTlsSelfCheckPath,
  plainPeerAllowed,
  type ApiTlsNetwork,
} from "./runtime/ApiTlsSupport.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { makePorts, probeVacant, type PortError } from "./Ports.ts";
import { bindTcp, serveTcp, type BackendAddress, type ProxyError } from "./Proxy.ts";
import {
  makeHttpProxy,
  type HttpAccessSink,
  type HttpFileRoute,
  type HttpProxy,
  type HttpProxyTls,
  type HttpRoute,
} from "./HttpProxy.ts";

export type NetworkRuntime = "native" | "docker" | "podman";

/* `target` serves a route from another backend than its endpoint's, like PostgREST's admin port. */
type RouteContribution =
  | (Pick<
      HttpRoute,
      | "prefix"
      | "upstreamPrefix"
      | "upstreamHost"
      | "addHeaders"
      | "forwardedPrefix"
      | "keyRewrite"
      | "upstreamCors"
    > &
      Partial<Pick<HttpRoute, "target">>)
  | Pick<HttpFileRoute, "prefix" | "file">;

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
  /** Sends each write to this endpoint, on every route, over a fresh upstream connection. */
  readonly freshWrites?: boolean;
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
  /** Set on the shared API endpoint's host address while it serves HTTPS. */
  readonly scheme?: "https";
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
   * Claims a native backend port for this stack until the ambient scope closes; `false` while
   * another live stack holds it.
   */
  readonly claimNativePort: (
    key: string,
    port: number,
  ) => Effect.Effect<boolean, PortError, Scope.Scope>;
  /** The shared API listener's port while it is open. */
  readonly apiPort: Effect.Effect<number | undefined>;
  /** Plain API peers the self-check with this token let in, outside the saved peer rule. */
  readonly learnedApiPeers: (token: string) => Effect.Effect<ReadonlyArray<string>>;
  /** Admits these engine networks, when any, in place of the saved ones for this token. */
  readonly adoptApiNetworks: (
    token: string,
    networks: ReadonlyArray<ApiTlsNetwork>,
  ) => Effect.Effect<void>;
  /**
   * Reopens the open shared API listener on its port with its routes when the saved TLS changed
   * since it opened, so the TLS a stopped stack takes is the one it serves.
   */
  readonly reopenApi: Effect.Effect<void, NetworkError>;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/Network") {}

const errorFor = (operation: string, cause: unknown) =>
  new NetworkError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** A later claimant reuses the open shared listener, so it never touches the port registry. */
const joinClaim = (
  existing: { readonly claim: number; readonly proxy: HttpProxy },
  port: number | "auto",
) =>
  port !== "auto" && port !== existing.claim
    ? Effect.fail(errorFor("bind", "Shared API port differs from existing claim"))
    : Effect.succeed({ port: existing.claim, listener: { proxy: existing.proxy } });

type SavedApiTls = NonNullable<StackNamespace.SavedStack["apiTls"]>;

const makeNetwork = (options: {
  readonly stackId: string;
  readonly runtime: NetworkRuntime;
  readonly state: StackNamespace.Interface;
  readonly platform?: NodeJS.Platform;
  readonly onAccess?: HttpAccessSink;
}) =>
  Effect.gen(function* () {
    const ports = yield* makePorts(options.state).pipe(
      Effect.mapError((cause) => errorFor("ports", cause)),
    );
    const probe = probeVacant(options.platform ?? process.platform);
    const owner = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    const shared = yield* Ref.make<
      | {
          readonly claim: number;
          readonly proxy: HttpProxy;
          readonly routes: ReadonlyArray<HttpRoute | HttpFileRoute>;
          readonly scope: Scope.Closeable;
          /** The port its first claimant requested, which a reopen requests again. */
          readonly requested: number | "auto";
          /** The self-check token of the TLS it serves, which host addresses follow; none is plain. */
          readonly selfCheck: string | undefined;
        }
      | undefined
    >(undefined);
    // Join routes queued before any claiming endpoint has created the shared listener.
    const pendingJoins = yield* Ref.make<ReadonlyArray<HttpRoute | HttpFileRoute>>([]);

    const listenHost = options.runtime === "native" ? "127.0.0.1" : "0.0.0.0";
    const hostAddress = "127.0.0.1";
    const runtimeAddress = options.runtime === "native" ? "127.0.0.1" : DOCKER_HOST_ALIAS;

    const apiTls = options.state.read(options.stackId).pipe(
      Effect.map((saved) => saved?.apiTls),
      Effect.mapError((cause) => errorFor("tls", cause)),
    );

    /* Owned by this network per self-check token, so a start that sets TLS again starts from its
       own saved peers and networks rather than an earlier generation's. */
    const learned = new Map<
      string,
      { readonly peers: Set<string>; networks: ReadonlyArray<ApiTlsNetwork> }
    >();
    const proxyTls = (tls: SavedApiTls): HttpProxyTls => {
      const current = learned.get(tls.selfCheck) ?? {
        peers: new Set(tls.learnedPeers),
        networks: tls.networks,
      };
      learned.set(tls.selfCheck, current);
      return {
        cert: tls.cert,
        key: tls.key,
        plainPeer: (peer, local) =>
          current.peers.has(peer) || plainPeerAllowed(current.networks)(peer, local),
        learn: { path: apiTlsSelfCheckPath(tls.selfCheck), add: (peer) => current.peers.add(peer) },
      };
    };

    /** Opens the shared API listener, serving the saved TLS when there is one. */
    const openApi = (host: string, port: number, tls: SavedApiTls | undefined) =>
      Effect.gen(function* () {
        yield* probe("api", host, port);
        const proxy = yield* makeHttpProxy({
          host,
          port,
          onAccess: options.onAccess,
          tls: tls === undefined ? undefined : proxyTls(tls),
        });
        return { proxy };
      });

    const routeKey = (route: Pick<HttpRoute, "id" | "prefix">) => `${route.id}:${route.prefix}`;

    /** Maps one endpoint's route contributions to routes; shared and joined proxy routes are `gateway` routes. */
    const toHttpRoutes = (
      id: string,
      contributions: ReadonlyArray<RouteContribution>,
      endpoint: Pick<NetworkEndpoint, "backend" | "freshWrites">,
      gateway: boolean,
    ): ReadonlyArray<HttpRoute | HttpFileRoute> =>
      contributions.map((route) =>
        "file" in route
          ? { ...route, id }
          : {
              ...route,
              id,
              ...(gateway ? { gateway: true } : {}),
              ...(endpoint.freshWrites === true ? { freshWrites: true } : {}),
              target: route.target ?? endpoint.backend,
            },
      );

    /** Installs a namespace's joined routes onto the shared listener, or queues them if it does not exist yet. */
    const installJoin = Effect.fn("Network.installJoin")(function* (
      routeId: string,
      join: NonNullable<NetworkEndpoint["join"]>,
      endpoint: NetworkEndpoint,
    ) {
      const routes = toHttpRoutes(routeId, join, endpoint, true);
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
            for (const [name, endpoint] of Object.entries(endpoints)) {
              if ((yield* Ref.get(bound)).has(name)) continue;
              const key = endpoint.shared === undefined ? `${id}:${name}` : "api";
              const claimed = endpoint.shared === undefined ? undefined : yield* Ref.get(shared);
              const tls =
                endpoint.shared !== undefined && claimed === undefined ? yield* apiTls : undefined;
              yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const endpointScope = yield* Scope.fork(owner, "sequential");
                  const result = yield* restore(
                    claimed !== undefined
                      ? joinClaim(claimed, endpoint.port)
                      : ports
                          .acquire<{ readonly proxy?: HttpProxy }, Scope.Scope>(
                            {
                              stackId: options.stackId,
                              key,
                              host: listenHost,
                              port: endpoint.port,
                            },
                            (host, port) =>
                              Effect.gen(function* () {
                                if (endpoint.shared !== undefined)
                                  return yield* openApi(host, port, tls);
                                if (endpoint.protocol === "http") {
                                  yield* probe(key, host, port);
                                  const proxy = yield* makeHttpProxy({ host, port });
                                  yield* proxy.setRoutes(
                                    toHttpRoutes(id, [{ prefix: "/" }], endpoint, false),
                                  );
                                  return { proxy };
                                }
                                yield* probe(key, host, port);
                                const listener = yield* bindTcp(host, port);
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
                    let seeded: ReadonlyArray<HttpRoute | HttpFileRoute> = [];
                    if (previous === undefined) seeded = yield* Ref.get(pendingJoins);
                    const current = previous ?? {
                      claim: result.port,
                      proxy: result.listener.proxy,
                      routes: seeded,
                      scope: endpointScope,
                      requested: endpoint.port,
                      selfCheck: tls?.selfCheck,
                    };
                    if (previous !== undefined) yield* Scope.close(endpointScope, Exit.void);
                    else if (seeded.length > 0) yield* Ref.set(pendingJoins, []);
                    const routes = [
                      ...current.routes,
                      ...toHttpRoutes(id, endpoint.shared, endpoint, true),
                    ];
                    yield* current.proxy.setRoutes(routes);
                    yield* Ref.set(shared, { ...current, routes });
                  } else {
                    yield* Ref.update(scopes, (current) =>
                      new Map(current).set(name, endpointScope),
                    );
                  }
                  if (endpoint.join !== undefined) yield* installJoin(id, endpoint.join, endpoint);
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
          const port =
            endpoint.port === "auto"
              ? yield* ports
                  .assigned(options.stackId, key)
                  .pipe(Effect.mapError((cause) => errorFor("address", cause)))
              : endpoint.port;
          if (port === undefined)
            return yield* errorFor("address", `Endpoint ${name} is not assigned`);
          /* Under TLS host clients use https, as the open listener serves or the next one will;
             runtimes keep plain http on the same port. */
          const active = yield* Ref.get(shared);
          const secure =
            from === "host" &&
            endpoint.shared !== undefined &&
            (active === undefined ? (yield* apiTls) !== undefined : active.selfCheck !== undefined);
          const https: Pick<NetworkBinding, "scheme"> = secure ? { scheme: "https" } : {};
          return {
            name,
            protocol: endpoint.protocol,
            host: from === "host" ? hostAddress : runtimeAddress,
            port,
            ...https,
          } satisfies NetworkBinding;
        }),
      );
      return {
        bind: bind(),
        close: close(),
        release: release(),
        releasePorts: releasePorts(),
        address,
        /* The shared endpoint's host address follows the TLS its open listener serves. */
        bindings: Effect.all([Ref.get(bound), Ref.get(shared)]).pipe(
          Effect.map(([values, active]) =>
            [...values.values()].map((binding): NetworkBinding =>
              endpoints[binding.name]?.shared !== undefined && active?.selfCheck !== undefined
                ? { ...binding, scheme: "https" }
                : binding,
            ),
          ),
        ),
      } satisfies NetworkNamespace;
    });

    const reopenApi = gate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(shared);
        if (current === undefined) return;
        const tls = yield* apiTls;
        if (tls?.selfCheck === current.selfCheck) return;
        yield* Scope.close(current.scope, Exit.void);
        yield* Ref.set(shared, undefined);
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(owner, "sequential");
            const result = yield* restore(
              ports
                .acquire(
                  {
                    stackId: options.stackId,
                    key: "api",
                    host: listenHost,
                    port: current.requested,
                  },
                  (host, port) => openApi(host, port, tls),
                )
                .pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.mapError((cause) => errorFor("bind", cause)),
                ),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
              ),
            );
            yield* result.listener.proxy.setRoutes(current.routes);
            yield* Ref.set(shared, {
              ...current,
              proxy: result.listener.proxy,
              scope,
              selfCheck: tls?.selfCheck,
            });
          }),
        );
      }),
    );

    const releaseStack = Effect.fn("Network.releaseStack")(() =>
      ports
        .releaseStack(options.stackId)
        .pipe(Effect.mapError((cause) => errorFor("release", cause))),
    );
    return {
      register,
      releaseStack: releaseStack(),
      claimNativePort: (key, port) => ports.claimNative(options.stackId, key, port),
      apiPort: Ref.get(shared).pipe(Effect.map((current) => current?.claim)),
      learnedApiPeers: (token) => Effect.sync(() => [...(learned.get(token)?.peers ?? [])]),
      adoptApiNetworks: (token, networks) =>
        Effect.sync(() => {
          const current = learned.get(token);
          if (current !== undefined && networks.length > 0) current.networks = networks;
        }),
      reopenApi,
    } satisfies Interface;
  });

export const layer = (options: {
  readonly stackId: string;
  readonly runtime: NetworkRuntime;
  /** Receives the shared API listener's completed requests. */
  readonly onAccess?: HttpAccessSink;
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* StackNamespace.Service;
      return yield* makeNetwork({ ...options, state });
    }).pipe(Effect.map(Service.of)),
  ).pipe(Layer.provide(PortReservations.layer));

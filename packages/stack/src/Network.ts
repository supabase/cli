import { Context, Data, Effect, Exit, Layer, Ref, Scope, Semaphore } from "effect";
import * as State from "./State.ts";
import { makePorts, PortError } from "./Ports.ts";
import { bindTcp, serveTcp, type BackendAddress, type ProxyError } from "./Proxy.ts";
import { makeHttpProxy, type HttpProxy, type HttpRoute } from "./HttpProxy.ts";

export type NetworkRuntime = "native" | "docker" | "podman";

export interface NetworkEndpoint {
  readonly protocol: "tcp" | "http";
  readonly port: number | "auto";
  readonly backend: Effect.Effect<BackendAddress, ProxyError, Scope.Scope>;
  readonly shared?: ReadonlyArray<{
    readonly prefix: string;
    readonly upstreamPrefix?: string;
    readonly upstreamHost?: string;
  }>;
  readonly enabled: Effect.Effect<boolean>;
}

class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NetworkBinding {
  readonly name: string;
  readonly protocol: "tcp" | "http";
  readonly host: string;
  readonly port: number;
}

export interface NetworkNamespace {
  readonly bindings: Effect.Effect<ReadonlyArray<NetworkBinding>>;
  readonly bind: Effect.Effect<ReadonlyArray<NetworkBinding>, NetworkError>;
  readonly close: Effect.Effect<void, NetworkError>;
  readonly release: Effect.Effect<void, NetworkError>;
  readonly address: (
    name: string,
    from: "host" | "runtime",
  ) => Effect.Effect<NetworkBinding, NetworkError>;
}

export interface Interface {
  readonly release: Effect.Effect<void, NetworkError>;
  readonly register: (options: {
    readonly id: string;
    readonly endpoints: Readonly<Record<string, NetworkEndpoint>>;
  }) => Effect.Effect<NetworkNamespace, NetworkError>;
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
  readonly state: State.Interface;
}) =>
  Effect.gen(function* () {
    const ports = yield* makePorts(options.state).pipe(
      Effect.mapError((cause) => errorFor("ports", cause)),
    );
    const owner = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    const shared = yield* Ref.make<
      | {
          readonly claim: number;
          readonly proxy: HttpProxy;
          readonly routes: ReadonlyArray<HttpRoute>;
          readonly scope: Scope.Closeable;
        }
      | undefined
    >(undefined);
    const namespaces = yield* Ref.make(new Map<string, ReadonlyArray<string>>());

    const listenHost = options.runtime === "native" ? "127.0.0.1" : "0.0.0.0";
    const hostAddress = "127.0.0.1";
    const runtimeAddress =
      options.runtime === "native"
        ? "127.0.0.1"
        : options.runtime === "docker"
          ? "host.docker.internal"
          : "host.containers.internal";

    const register = Effect.fn("Network.register")(function* ({
      id,
      endpoints,
    }: {
      readonly id: string;
      readonly endpoints: Readonly<Record<string, NetworkEndpoint>>;
    }) {
      const names = Object.keys(endpoints);
      const duplicate = yield* Ref.modify(namespaces, (current) => [
        current.has(id),
        current.has(id) ? current : new Map(current).set(id, names),
      ]);
      if (duplicate) return yield* errorFor("register", `Duplicate instance ${id}`);
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
                              return { proxy: yield* makeHttpProxy({ host, port }) };
                            }
                            if (endpoint.protocol === "http") {
                              const proxy = yield* makeHttpProxy({ host, port });
                              yield* proxy.setRoutes([
                                { id, prefix: "/", target: endpoint.backend },
                              ]);
                              return { proxy };
                            }
                            const listener = yield* bindTcp(host, port);
                            yield* Effect.forkIn(
                              serveTcp(listener, endpoint.backend).pipe(
                                Effect.provideService(Scope.Scope, endpointScope),
                                Effect.catch((cause) =>
                                  Effect.logWarning("Public listener failed", cause),
                                ),
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
                    const current = previous ?? {
                      claim: result.port,
                      proxy: result.listener.proxy,
                      routes: [],
                      scope: endpointScope,
                    };
                    if (previous !== undefined) yield* Scope.close(endpointScope, Exit.void);
                    const routes = [
                      ...current.routes,
                      ...endpoint.shared.map((route) => ({
                        id,
                        prefix: route.prefix,
                        upstreamPrefix: route.upstreamPrefix,
                        upstreamHost: route.upstreamHost,
                        target: endpoint.backend,
                      })),
                    ];
                    yield* current.proxy.setRoutes(routes);
                    yield* Ref.set(shared, { ...current, routes });
                  } else {
                    yield* Ref.update(scopes, (current) =>
                      new Map(current).set(name, endpointScope),
                    );
                  }
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
              for (const name of names) {
                const endpoint = endpoints[name];
                if (endpoint?.shared === undefined)
                  yield* ports
                    .release(options.stackId, `${id}:${name}`)
                    .pipe(Effect.mapError((cause) => errorFor("release", cause)));
              }
              yield* Ref.update(namespaces, (current) => {
                const next = new Map(current);
                next.delete(id);
                return next;
              });
            }),
          ),
        ),
      );
      const address = Effect.fn("Network.address")((name: string, from: "host" | "runtime") =>
        Effect.gen(function* () {
          const endpoint = endpoints[name];
          if (endpoint === undefined) return yield* errorFor("address", `Unknown endpoint ${name}`);
          const saved = yield* options.state
            .read(options.stackId)
            .pipe(Effect.mapError((cause) => errorFor("address", cause)));
          const key = endpoint.shared === undefined ? `${id}:${name}` : "api";
          const claim = saved?.ports.find((value) => value.key === key);
          if (claim === undefined)
            return yield* errorFor("address", `Endpoint ${name} is not assigned`);
          return {
            name,
            protocol: endpoint.protocol,
            host: from === "host" ? hostAddress : runtimeAddress,
            port: claim.port,
          };
        }),
      );
      return {
        bind: bind(),
        close: close(),
        release: release(),
        address,
        bindings: Ref.get(bound).pipe(Effect.map((values) => [...values.values()])),
      } satisfies NetworkNamespace;
    });

    const release = Effect.fn("Network.releaseNamespace")(() =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(namespaces)).size !== 0)
            return yield* errorFor("release", "Destroy instances before releasing the namespace");
          yield* ports
            .release(options.stackId, "api")
            .pipe(Effect.mapError((cause) => errorFor("release", cause)));
        }),
      ),
    );
    return { register, release: release() } satisfies Interface;
  });

export const layer = (options: { readonly stackId: string; readonly runtime: NetworkRuntime }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* State.Service;
      return yield* makeNetwork({ ...options, state });
    }).pipe(Effect.map(Service.of)),
  );

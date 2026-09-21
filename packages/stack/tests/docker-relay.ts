import { Effect, Predicate } from "effect";
import { bindTcp, serveTcp, ProxyError } from "../src/Proxy.ts";
import { makeHttpProxy } from "../src/HttpProxy.ts";
import type { ServiceEndpoint } from "../src/services/Recipe.ts";

const address = <E>(endpoint: Effect.Effect<ServiceEndpoint, E>) =>
  endpoint.pipe(
    Effect.flatMap((value) =>
      value.kind === "tcp" && value.host !== undefined
        ? Effect.succeed({ host: value.host, port: value.port })
        : Effect.fail(new ProxyError({ message: "Service endpoint is not TCP" })),
    ),
    Effect.mapError((cause) =>
      cause instanceof ProxyError ? cause : new ProxyError({ message: String(cause), cause }),
    ),
  );

export const makeDockerTcpRelay = Effect.fn("DockerRelay.makeTcp")(
  <E>(endpoint: Effect.Effect<ServiceEndpoint, E>) =>
    Effect.gen(function* () {
      const listener = yield* bindTcp("0.0.0.0", 0);
      if (!Predicate.isTagged(listener.address, "TcpAddress"))
        return yield* Effect.die("Expected TCP relay listener");
      yield* serveTcp(listener, address(endpoint)).pipe(Effect.forkScoped);
      return { host: "host.docker.internal", port: listener.address.port };
    }),
);

export const makeDockerHttpRelay = Effect.fn("DockerRelay.makeHttp")(
  <E>(endpoint: Effect.Effect<ServiceEndpoint, E>) =>
    Effect.gen(function* () {
      const proxy = yield* makeHttpProxy({ host: "0.0.0.0", port: 0 });
      yield* proxy.setRoutes([{ id: "service", prefix: "/", target: address(endpoint) }]);
      return { host: "host.docker.internal", port: proxy.port };
    }),
);

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Context, Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * Transport boundary for requests to a local Supabase gateway.
 *
 * Local gateway traffic must not inherit the process' proxy environment. The
 * production implementation uses Node's direct HTTP transport and scopes an
 * optional local Kong CA to the operation. Tests provide their captured
 * HttpClient instead, keeping route-state mocks authoritative while exercising
 * the same boundary as production.
 */
export interface LegacyLocalGatewayHttpClientShape {
  readonly use: <A, E, R>(
    localKongCa: string | undefined,
    effect: Effect.Effect<A, E, R | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, R>;
}

export class LegacyLocalGatewayHttpClient extends Context.Service<
  LegacyLocalGatewayHttpClient,
  LegacyLocalGatewayHttpClientShape
>()("supabase/legacy/LocalGatewayHttpClient") {}

function nodeHttpLayer(localKongCa: string | undefined): Layer.Layer<HttpClient.HttpClient> {
  return NodeHttpClient.layerNodeHttpNoAgent.pipe(
    Layer.provide(
      NodeHttpClient.layerAgentOptions(localKongCa === undefined ? undefined : { ca: localKongCa }),
    ),
  );
}

/** Production transport: direct node:http/https with an optional Kong CA. */
export const legacyLocalGatewayHttpClientLayer = Layer.succeed(LegacyLocalGatewayHttpClient, {
  use: (localKongCa, effect) => effect.pipe(Effect.provide(nodeHttpLayer(localKongCa))),
});

/** Test transport: preserve the caller's captured/mock HttpClient layer. */
export const legacyLocalGatewayHttpClientTestLayer = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Layer.Layer<LegacyLocalGatewayHttpClient> =>
  Layer.succeed(LegacyLocalGatewayHttpClient, {
    use: (_localKongCa, effect) => effect.pipe(Effect.provide(httpClientLayer)),
  });

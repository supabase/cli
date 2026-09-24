import type { HttpRoute } from "../HttpProxy.ts";
import type { ServiceCreation } from "../services/Catalog.ts";

type RouteKeys = NonNullable<HttpRoute["keyRewrite"]>["keys"];

export type SharedRoute = Pick<
  HttpRoute,
  "prefix" | "upstreamPrefix" | "upstreamHost" | "addHeaders" | "keyRewrite"
> & { readonly target?: HttpRoute["target"] };

type RouteBackend = (endpoint: string) => HttpRoute["target"];

const bearer = (keys: RouteKeys) => ({ policy: "bearer" as const, keys });

export const routesFor = (
  service: ServiceCreation["service"],
  endpoint: string,
  keys: RouteKeys,
  backend: RouteBackend,
): ReadonlyArray<SharedRoute> => {
  if (endpoint !== "http") return [];

  switch (service) {
    case "rest":
      return [
        { prefix: "/rest/v1", upstreamPrefix: "/", keyRewrite: bearer(keys) },
        {
          prefix: "/graphql/v1",
          upstreamPrefix: "/rpc/graphql",
          addHeaders: { "content-profile": "graphql_public" },
          keyRewrite: bearer(keys),
        },
        { prefix: "/rest-admin/v1", upstreamPrefix: "/", target: backend("admin") },
      ];
    case "auth":
      return [
        {
          prefix: "/.well-known/oauth-authorization-server",
          upstreamPrefix: "/.well-known/oauth-authorization-server",
        },
        ...["verify", "callback", "authorize"].map((name) => ({
          prefix: `/auth/v1/${name}`,
          upstreamPrefix: `/${name}`,
        })),
        { prefix: "/auth/v1", upstreamPrefix: "/", keyRewrite: bearer(keys) },
      ];
    case "storage":
      return [
        { prefix: "/storage/v1/s3", upstreamPrefix: "/s3" },
        { prefix: "/storage/v1", upstreamPrefix: "/", keyRewrite: bearer(keys) },
      ];
    case "realtime":
      return [
        {
          prefix: "/realtime/v1/api",
          upstreamPrefix: "/api",
          upstreamHost: "realtime-dev",
          keyRewrite: bearer(keys),
        },
        {
          prefix: "/realtime/v1",
          upstreamPrefix: "/socket",
          upstreamHost: "realtime-dev",
          keyRewrite: { policy: "query", keys },
        },
      ];
    case "functions":
      return [
        {
          prefix: "/functions/v1",
          upstreamPrefix: "/",
          keyRewrite: { policy: "sb-api-key", keys },
        },
      ];
    case "pgmeta":
      return [{ prefix: "/pg", upstreamPrefix: "/" }];
    case "analytics":
      return [{ prefix: "/analytics/v1", upstreamPrefix: "/" }];
    case "pooler":
      return [{ prefix: "/pooler/v2", upstreamPrefix: "/v2" }];
    case "studio":
      return [{ prefix: "/mcp", upstreamPrefix: "/api/mcp" }];
    default:
      return [];
  }
};

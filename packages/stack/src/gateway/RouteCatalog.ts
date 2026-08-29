import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { PortField } from "../public/Status.ts";
import type { GatewayRoute, GatewayRouteRequest } from "./Gateway.ts";

export interface GatewayRouteCatalog {
  readonly http: ReadonlyMap<PortField, ReadonlyArray<GatewayRoute>>;
  readonly tcp: ReadonlyMap<PortField, ReadonlyArray<GatewayRoute>>;
}

const pathStartsWith =
  (prefix: string) =>
  (path: string): boolean =>
    path === prefix || path.startsWith(`${prefix}/`);

const pathAndQuery = (requestPath: string): readonly [string, string] => {
  const queryIndex = requestPath.indexOf("?");
  return queryIndex < 0
    ? [requestPath, ""]
    : [requestPath.slice(0, queryIndex), requestPath.slice(queryIndex)];
};

const stripPrefix =
  (prefix: string) =>
  (request: GatewayRouteRequest): string => {
    const [pathname, query] = pathAndQuery(request.path);
    const suffix = pathname.slice(prefix.length);
    return `${suffix.length === 0 ? "/" : suffix}${query}`;
  };

const appendSuffix =
  (base: string, prefix: string) =>
  (request: GatewayRouteRequest): string => {
    const [pathname, query] = pathAndQuery(request.path);
    const suffix = pathname.slice(prefix.length);
    return `${base}${suffix}${query}`;
  };

const prefixRoute = (
  capability: CapabilityName,
  prefix: string,
  upstreamPath: (request: GatewayRouteRequest) => string = stripPrefix(prefix),
  match: (request: GatewayRouteRequest) => boolean = (request) =>
    pathStartsWith(prefix)(pathAndQuery(request.path)[0]),
): GatewayRoute => ({
  capability,
  match,
  upstreamPath,
});

const directRoute = (capability: CapabilityName, binding?: string): GatewayRoute => ({
  capability,
  ...(binding === undefined ? {} : { binding }),
  match: () => true,
});

const realtimeWebsocketRoute = (): GatewayRoute =>
  prefixRoute("realtime", "/realtime/v1", appendSuffix("/socket", "/realtime/v1"), (request) => {
    const [pathname] = pathAndQuery(request.path);
    const upgrade = request.headers["upgrade"];
    const isUpgrade = Array.isArray(upgrade)
      ? upgrade.some((value) => value.toLowerCase() === "websocket")
      : upgrade?.toLowerCase() === "websocket";
    return (
      pathStartsWith("/realtime/v1")(pathname) &&
      (isUpgrade || pathname === "/realtime/v1/websocket")
    );
  });

const realtimeRestRoute = (): GatewayRoute =>
  prefixRoute("realtime", "/realtime/v1/api", stripPrefix("/realtime/v1"));

const apiRoutes = (capability: CapabilityName): ReadonlyArray<GatewayRoute> => {
  switch (capability) {
    case "rest":
      return [
        prefixRoute(capability, "/rest/v1"),
        prefixRoute(capability, "/graphql/v1", appendSuffix("/rpc/graphql", "/graphql/v1")),
      ];
    case "auth":
      return [prefixRoute(capability, "/auth/v1")];
    case "realtime":
      return [realtimeWebsocketRoute(), realtimeRestRoute(), prefixRoute(capability, "/socket")];
    case "storage":
      return [
        prefixRoute(capability, "/storage/v1/s3", appendSuffix("/s3", "/storage/v1/s3")),
        prefixRoute(capability, "/storage/v1"),
      ];
    case "functions":
      return [prefixRoute(capability, "/functions/v1")];
    case "analytics":
      return [prefixRoute(capability, "/analytics/v1")];
    case "database":
    case "pooler":
    case "studio":
    case "mail":
      return [];
  }
};

/** Build the closed public route set from the enabled plan, in collision-safe order. */
export const routeCatalogFor = (plan: ExecutionPlan): GatewayRouteCatalog => {
  const http = new Map<PortField, GatewayRoute[]>();
  const tcp = new Map<PortField, GatewayRoute[]>();
  const append = (
    target: Map<PortField, GatewayRoute[]>,
    field: PortField,
    routes: ReadonlyArray<GatewayRoute>,
  ) => {
    const current = target.get(field) ?? [];
    current.push(...routes);
    target.set(field, current);
  };
  for (const route of plan.routes) {
    if (route.listener === "api" && route.protocol === "http")
      append(http, route.listener, apiRoutes(route.capability));
    else if (route.listener === "studio" && route.protocol === "http")
      append(http, route.listener, [directRoute(route.capability)]);
    else if (route.listener === "mailUi" && route.protocol === "http")
      append(http, route.listener, [directRoute(route.capability, "ui")]);
    else if (route.listener === "functionsInspector" && route.protocol === "http")
      append(http, route.listener, [directRoute(route.capability)]);
    else if (route.listener === "database" && route.protocol === "tcp")
      append(tcp, route.listener, [directRoute(route.capability, "primary")]);
    else if (route.listener === "pooler" && route.protocol === "tcp")
      append(tcp, route.listener, [directRoute(route.capability, "primary")]);
    else if (route.listener === "smtp" && route.protocol === "tcp")
      append(tcp, route.listener, [directRoute(route.capability, "smtp")]);
    else if (route.listener === "pop3" && route.protocol === "tcp")
      append(tcp, route.listener, [directRoute(route.capability, "pop3")]);
  }
  return { http, tcp };
};

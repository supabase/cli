import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { PortField } from "../public/Status.ts";
import type {
  GatewayHeaderTransform,
  GatewayHeaders,
  GatewayRoute,
  GatewayRouteRequest,
} from "./Gateway.ts";

export interface GatewayRouteCatalog {
  readonly http: ReadonlyMap<PortField, ReadonlyArray<GatewayRoute>>;
  readonly tcp: ReadonlyMap<PortField, ReadonlyArray<GatewayRoute>>;
}

/** Owner-resolved API material used only for forwarding transformations. */
export interface GatewayApiMaterial {
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
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

const headerValue = (headers: GatewayHeaders, name: string): string | undefined => {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
};

const removeHeader = (headers: Record<string, string | string[]>, name: string): void => {
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
};

const apiKeyJwt = (value: string | undefined, material: GatewayApiMaterial): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const candidate = /^Bearer\s+/iu.test(trimmed) ? trimmed.slice(7).trim() : trimmed;
  if (candidate === material.publishableKey) return material.anonJwt;
  if (candidate === material.secretKey) return material.serviceRoleJwt;
  return undefined;
};

const authorizationTransform =
  (material: GatewayApiMaterial, target: "authorization" | "sb-api-key"): GatewayHeaderTransform =>
  (_request, headers) => {
    const output: Record<string, string | string[]> = { ...headers };
    const authorization = headerValue(headers, "authorization");
    const apikey = headerValue(headers, "apikey");
    const jwt =
      target === "sb-api-key"
        ? (apiKeyJwt(apikey, material) ?? apiKeyJwt(authorization, material))
        : authorization === undefined
          ? apiKeyJwt(apikey, material)
          : apiKeyJwt(authorization, material);
    if (jwt === undefined) {
      if (target === "sb-api-key") removeHeader(output, target);
      return output;
    }
    removeHeader(output, target);
    output[target] = `Bearer ${jwt}`;
    return output;
  };

const composeHeaders =
  (...transforms: ReadonlyArray<GatewayHeaderTransform>): GatewayHeaderTransform =>
  (request, headers) =>
    transforms.reduce((current, transform) => transform(request, current), headers);

const preserveHeaders: GatewayHeaderTransform = (_request, headers) => ({ ...headers });

const graphqlHeaders = (material: GatewayApiMaterial): GatewayHeaderTransform =>
  composeHeaders(authorizationTransform(material, "authorization"), (_request, headers) => {
    const output: Record<string, string | string[]> = { ...headers };
    removeHeader(output, "content-profile");
    output["content-profile"] = "graphql_public";
    return output;
  });

const realtimeWebsocketPath =
  (material: GatewayApiMaterial | undefined) =>
  (request: GatewayRouteRequest): string => {
    const forwarded = appendSuffix("/socket", "/realtime/v1")(request);
    if (material === undefined) return forwarded;
    const [pathname, query] = pathAndQuery(forwarded);
    if (query.length === 0) return forwarded;
    const mapped = query
      .slice(1)
      .split("&")
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return part;
        const key = decodeURIComponent(part.slice(0, separator));
        if (key !== "apikey") return part;
        const value = decodeURIComponent(part.slice(separator + 1));
        const jwt = apiKeyJwt(value, material);
        return jwt === undefined
          ? part
          : `${part.slice(0, separator + 1)}${encodeURIComponent(jwt)}`;
      })
      .join("&");
    return `${pathname}?${mapped}`;
  };

const realtimeWebsocketHeaders =
  (material: GatewayApiMaterial | undefined): GatewayHeaderTransform =>
  (request, headers) => {
    const output: Record<string, string | string[]> = {
      ...(material === undefined
        ? headers
        : authorizationTransform(material, "authorization")(request, headers)),
    };
    removeHeader(output, "host");
    output.host = "realtime-dev";
    return output;
  };

const prefixRoute = (
  capability: CapabilityName,
  prefix: string,
  upstreamPath: (request: GatewayRouteRequest) => string = stripPrefix(prefix),
  match: (request: GatewayRouteRequest) => boolean = (request) =>
    pathStartsWith(prefix)(pathAndQuery(request.path)[0]),
  upstreamHeaders?: GatewayHeaderTransform,
): GatewayRoute => ({
  capability,
  match,
  upstreamPath,
  ...(upstreamHeaders === undefined ? {} : { upstreamHeaders }),
});

const directRoute = (capability: CapabilityName, binding?: string): GatewayRoute => ({
  capability,
  ...(binding === undefined ? {} : { binding }),
  match: () => true,
});

const realtimeWebsocketRoute = (material?: GatewayApiMaterial): GatewayRoute =>
  prefixRoute(
    "realtime",
    "/realtime/v1",
    realtimeWebsocketPath(material),
    (request) => {
      const [pathname] = pathAndQuery(request.path);
      const upgrade = request.headers["upgrade"];
      const isUpgrade = Array.isArray(upgrade)
        ? upgrade.some((value) => value.toLowerCase() === "websocket")
        : upgrade?.toLowerCase() === "websocket";
      return (
        pathStartsWith("/realtime/v1")(pathname) &&
        (isUpgrade || pathname === "/realtime/v1/websocket")
      );
    },
    realtimeWebsocketHeaders(material),
  );

const apiRoutes = (
  capability: CapabilityName,
  material?: GatewayApiMaterial,
): ReadonlyArray<GatewayRoute> => {
  switch (capability) {
    case "rest":
      return [
        prefixRoute(
          capability,
          "/rest/v1",
          stripPrefix("/rest/v1"),
          undefined,
          material === undefined ? undefined : authorizationTransform(material, "authorization"),
        ),
        prefixRoute(
          capability,
          "/graphql/v1",
          appendSuffix("/rpc/graphql", "/graphql/v1"),
          undefined,
          material === undefined ? undefined : graphqlHeaders(material),
        ),
      ];
    case "auth":
      return [
        prefixRoute(
          capability,
          "/auth/v1",
          stripPrefix("/auth/v1"),
          undefined,
          material === undefined ? undefined : authorizationTransform(material, "authorization"),
        ),
      ];
    case "realtime":
      return [
        realtimeWebsocketRoute(material),
        prefixRoute(
          capability,
          "/realtime/v1/api",
          stripPrefix("/realtime/v1"),
          undefined,
          material === undefined ? undefined : authorizationTransform(material, "authorization"),
        ),
        prefixRoute(capability, "/socket"),
      ];
    case "storage":
      return [
        prefixRoute(
          capability,
          "/storage/v1/s3",
          appendSuffix("/s3", "/storage/v1/s3"),
          undefined,
          preserveHeaders,
        ),
        prefixRoute(
          capability,
          "/storage/v1",
          stripPrefix("/storage/v1"),
          undefined,
          material === undefined ? undefined : authorizationTransform(material, "authorization"),
        ),
      ];
    case "functions":
      return [
        prefixRoute(
          capability,
          "/functions/v1",
          stripPrefix("/functions/v1"),
          undefined,
          material === undefined ? undefined : authorizationTransform(material, "sb-api-key"),
        ),
      ];
    case "analytics":
      return [
        prefixRoute(
          capability,
          "/analytics/v1",
          stripPrefix("/analytics/v1"),
          undefined,
          material === undefined ? undefined : authorizationTransform(material, "authorization"),
        ),
      ];
    case "database":
    case "pooler":
    case "studio":
    case "mail":
      return [];
  }
};

/** Build the closed public route set from the enabled plan, in collision-safe order. */
export const routeCatalogFor = (
  plan: ExecutionPlan,
  material?: GatewayApiMaterial,
): GatewayRouteCatalog => {
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
      append(http, route.listener, apiRoutes(route.capability, material));
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

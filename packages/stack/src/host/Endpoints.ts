import { allowedEndpointNames, type ServiceCreation } from "../services/Catalog.ts";
import type { ServiceEndpoint } from "../services/Recipe.ts";
import { apiPath as storageApiPath } from "../services/Storage.ts";
import type { NetworkEndpoint } from "../Network.ts";
import type { BackendAddress } from "../Proxy.ts";
import { Data, Effect, Redacted } from "effect";

export class EndpointError extends Data.TaggedError("EndpointError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type EndpointIntents = Pick<ServiceCreation, "service" | "endpoints">;

export const endpointNames = (creation: EndpointIntents): ReadonlyArray<string> => {
  const configured: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(creation.endpoints ?? {}),
  );
  return allowedEndpointNames(creation.service).filter((name) => isRecord(configured[name]));
};

export const endpointPort = (creation: EndpointIntents, name: string): number | "auto" => {
  const endpoints: unknown = creation.endpoints;
  if (!isRecord(endpoints)) return "auto";
  const endpoint = endpoints[name];
  if (!isRecord(endpoint)) return "auto";
  return endpoint.port === "auto" || typeof endpoint.port === "number" ? endpoint.port : "auto";
};

/**
 * Path prefix of a service on the shared API listener, or `undefined` when it has a dedicated one.
 * Accepts a plain string too, for a service kind decoded off an RPC transport.
 */
export const apiRoute = (service: string): string | undefined => {
  switch (service) {
    case "rest":
      return "/rest/v1";
    case "auth":
      return "/auth/v1";
    case "storage":
      return storageApiPath;
    case "functions":
      return "/functions/v1";
    case "realtime":
      return "/realtime/v1";
    default:
      return undefined;
  }
};

/** Whether the service's configured HTTP endpoint is served on the shared API listener. */
export const sharesApiEndpoint = (creation: EndpointIntents): boolean =>
  apiRoute(creation.service) !== undefined && endpointNames(creation).includes("http");

type RouteKeys = NonNullable<NonNullable<NetworkEndpoint["shared"]>[number]["keyRewrite"]>["keys"];

/**
 * Routes a service's HTTP endpoint on the shared API listener, or `undefined` for a dedicated one.
 * `backend` reaches another of the service's endpoints, like PostgREST's admin port.
 */
export const sharedRoutes = (
  creation: Pick<ServiceCreation, "service">,
  name: string,
  keys: RouteKeys,
  backend: (endpoint: string) => NetworkEndpoint["backend"],
): NetworkEndpoint["shared"] => {
  const route = name === "http" ? apiRoute(creation.service) : undefined;
  if (route === undefined) return undefined;
  switch (creation.service) {
    case "realtime":
      return [
        {
          prefix: "/realtime/v1/api",
          upstreamPrefix: "/api",
          upstreamHost: "realtime-dev",
          forwardedPrefix: "/realtime/v1/api",
          keyRewrite: { policy: "bearer", keys },
        },
        {
          prefix: route,
          upstreamPrefix: "/socket",
          upstreamHost: "realtime-dev",
          keyRewrite: { policy: "query", keys },
        },
      ];
    case "storage":
      return [
        { prefix: `${route}/s3`, upstreamPrefix: "/s3" },
        { prefix: route, upstreamPrefix: "/", keyRewrite: { policy: "bearer", keys } },
      ];
    case "rest":
      return [
        { prefix: route, upstreamPrefix: "/", keyRewrite: { policy: "bearer", keys } },
        {
          prefix: "/graphql/v1",
          upstreamPrefix: "/rpc/graphql",
          forwardedPrefix: "/graphql/v1",
          addHeaders: { "content-profile": "graphql_public" },
          keyRewrite: { policy: "bearer", keys },
        },
        { prefix: "/rest-admin/v1", upstreamPrefix: "/", target: backend("admin") },
      ];
    case "auth":
      return [
        /* Like legacy Kong, email links, OAuth redirects and discovery keep the client's headers. */
        ...["verify", "callback", "authorize"].map((path) => ({
          prefix: `${route}/${path}`,
          upstreamPrefix: `/${path}`,
          forwardedPrefix: `${route}/${path}`,
        })),
        {
          prefix: "/.well-known/oauth-authorization-server",
          upstreamPrefix: "/.well-known/oauth-authorization-server",
          forwardedPrefix: "/.well-known/oauth-authorization-server",
        },
        { prefix: route, upstreamPrefix: "/", keyRewrite: { policy: "bearer", keys } },
      ];
    case "functions":
      return [{ prefix: route, upstreamPrefix: "/", keyRewrite: { policy: "sb-api-key", keys } }];
    default:
      return [{ prefix: route, upstreamPrefix: "/" }];
  }
};

/**
 * Shared-listener routes a dedicated HTTP endpoint also serves while its service runs, like
 * legacy Kong's: Studio's MCP server, postgres-meta, Logflare and Supavisor's API.
 */
export const joinRoutes = (
  creation: Pick<ServiceCreation, "service">,
  name: string,
): NetworkEndpoint["join"] => {
  if (name !== "http") return undefined;
  switch (creation.service) {
    case "studio":
      return [{ prefix: "/mcp", upstreamPrefix: "/api/mcp", forwardedPrefix: "/mcp" }];
    case "pgmeta":
      return [{ prefix: "/pg", upstreamPrefix: "/" }];
    case "analytics":
      return [{ prefix: "/analytics/v1", upstreamPrefix: "/" }];
    case "pooler":
      return [{ prefix: "/pooler/v2", upstreamPrefix: "/v2" }];
    default:
      return undefined;
  }
};

/**
 * Whether an endpoint's writes each take a fresh upstream connection instead of the pool: only
 * Studio's, `/mcp` included; its reads and every other endpoint's writes stay pooled.
 */
export const freshWrites = (creation: EndpointIntents, name: string): boolean =>
  creation.service === "studio" && name === "http";

/** Translates a launched runtime's endpoint into the proxy's backend address. */
export const backendAddress = (endpoint: ServiceEndpoint): BackendAddress =>
  endpoint.kind === "unix"
    ? { path: endpoint.path }
    : { host: endpoint.host ?? "127.0.0.1", port: endpoint.port };

export const publicUrl = (host: string, port: number) => `http://${host}:${port}`;

const postgresUrl = (
  host: string,
  port: number,
  role: string,
  password: string,
  database: string,
) =>
  `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

interface EndpointAddress {
  readonly host: string;
  readonly port: number;
}

export type EndpointAddressFor<E> = (
  endpoint: string,
  from: "host" | "runtime",
) => Effect.Effect<EndpointAddress, E>;

const databasePassword = (creation: ServiceCreation): Effect.Effect<string, EndpointError> =>
  creation.service === "database"
    ? Effect.succeed(Redacted.value(creation.config.databasePassword))
    : Effect.fail(new EndpointError({ message: "Database URLs require a database" }));

/** Renders dependency outputs; `current` supplies the saved creation at resolution time. */
export const outputsFor = <E>(
  creation: ServiceCreation,
  current: Effect.Effect<ServiceCreation>,
  address: EndpointAddressFor<E>,
): Readonly<Record<string, Effect.Effect<string, E | EndpointError>>> => {
  const output = (name: string) =>
    address(name, "runtime").pipe(Effect.map(({ host, port }) => publicUrl(host, port)));
  const outputs: Record<string, Effect.Effect<string, E | EndpointError>> = {};
  if (endpointNames(creation).includes("http")) {
    outputs.url = output("http");
    outputs.hostUrl = address("http", "host").pipe(
      Effect.map(({ host, port }) => publicUrl(host, port)),
    );
    outputs.runtimeUrl = output("http");
  }
  if (creation.service === "mail" && endpointNames(creation).includes("smtp"))
    outputs.smtpUrl = address("smtp", "runtime").pipe(
      Effect.map(({ host, port }) => `smtp://${host}:${port}`),
    );
  if (creation.service === "database" && endpointNames(creation).includes("sql")) {
    for (const [name, role, database] of [
      ["databaseUrl", "supabase_admin", "postgres"],
      ["authenticatorUrl", "authenticator", "postgres"],
      ["authDatabaseUrl", "supabase_auth_admin", "postgres"],
      ["storageDatabaseUrl", "supabase_storage_admin", "postgres"],
      ["internalDatabaseUrl", "supabase_admin", "_supabase"],
    ] as const)
      outputs[name] = address("sql", "runtime").pipe(
        Effect.flatMap(({ host, port }) =>
          current.pipe(
            Effect.flatMap(databasePassword),
            Effect.map((value) => postgresUrl(host, port, role, value, database)),
          ),
        ),
      );
  }
  return outputs;
};

export const credentialsFor = Effect.fn("Endpoints.credentialsFor")(function* <E>(
  creation: ServiceCreation,
  address: EndpointAddressFor<E>,
  from: "host" | "runtime",
) {
  const credentials: Record<string, string> = {};
  if (endpointNames(creation).includes("http")) {
    const { host, port } = yield* address("http", from);
    const origin = publicUrl(host, port);
    credentials.url = `${origin}${apiRoute(creation.service) ?? ""}`;
    if (apiRoute(creation.service) !== undefined) credentials.apiUrl = origin;
  }
  if (creation.service === "mail") {
    if (endpointNames(creation).includes("smtp")) {
      const { host, port } = yield* address("smtp", from);
      credentials.smtpUrl = `smtp://${host}:${port}`;
    }
    if (endpointNames(creation).includes("pop3")) {
      const { host, port } = yield* address("pop3", from);
      credentials.pop3Url = `pop3://${host}:${port}`;
    }
  }
  if (creation.service === "pooler" && endpointNames(creation).includes("sql")) {
    const { host, port } = yield* address("sql", from);
    credentials.sqlUrl = `postgresql://${host}:${port}`;
  }
  if (creation.service === "database" && endpointNames(creation).includes("sql")) {
    const { host, port } = yield* address("sql", from);
    const value = yield* databasePassword(creation);
    for (const [name, role, database] of [
      ["databaseUrl", "supabase_admin", "postgres"],
      ["authenticatorUrl", "authenticator", "postgres"],
      ["authDatabaseUrl", "supabase_auth_admin", "postgres"],
      ["storageDatabaseUrl", "supabase_storage_admin", "postgres"],
      ["internalDatabaseUrl", "supabase_admin", "_supabase"],
    ] as const)
      credentials[name] = postgresUrl(host, port, role, value, database);
  }
  return credentials;
});

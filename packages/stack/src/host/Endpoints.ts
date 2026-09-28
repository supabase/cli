import { allowedEndpointNames, type ServiceCreation } from "../services/Catalog.ts";
import type { ServiceEndpoint } from "../services/Recipe.ts";
import type { NetworkEndpoint } from "../Network.ts";
import { ProxyError, type BackendAddress } from "../Proxy.ts";
import { Data, Effect, Redacted } from "effect";

export class EndpointError extends Data.TaggedError("EndpointError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const endpointNames = (creation: ServiceCreation): ReadonlyArray<string> => {
  const configured: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(creation.endpoints ?? {}),
  );
  return allowedEndpointNames(creation.service).filter((name) => isRecord(configured[name]));
};

export const endpointPort = (creation: ServiceCreation, name: string): number | "auto" => {
  const endpoints: unknown = creation.endpoints;
  if (!isRecord(endpoints)) return "auto";
  const endpoint = endpoints[name];
  if (!isRecord(endpoint)) return "auto";
  return endpoint.port === "auto" || typeof endpoint.port === "number" ? endpoint.port : "auto";
};

export const apiRoute = (service: ServiceCreation["service"]): string | undefined => {
  switch (service) {
    case "rest":
      return "/rest/v1";
    case "auth":
      return "/auth/v1";
    case "storage":
      return "/storage/v1";
    case "functions":
      return "/functions/v1";
    case "realtime":
      return "/realtime/v1";
    default:
      return undefined;
  }
};

type RouteKeys = NonNullable<NonNullable<NetworkEndpoint["shared"]>[number]["keyRewrite"]>["keys"];

/** Routes a service's HTTP endpoint on the shared API listener, or `undefined` for a dedicated one. */
export const sharedRoutes = (
  creation: ServiceCreation,
  name: string,
  keys: RouteKeys,
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
    case "auth":
      return [{ prefix: route, upstreamPrefix: "/", keyRewrite: { policy: "bearer", keys } }];
    case "functions":
      return [{ prefix: route, upstreamPrefix: "/", keyRewrite: { policy: "sb-api-key", keys } }];
    default:
      return [{ prefix: route, upstreamPrefix: "/" }];
  }
};

/** Translates a launched runtime's endpoint into the proxy's backend address. */
export const backendAddress = (
  endpoint: ServiceEndpoint,
): Effect.Effect<BackendAddress, ProxyError> => {
  if (endpoint.kind === "unix")
    return endpoint.path === undefined
      ? Effect.fail(new ProxyError({ message: "Unix endpoint has no path" }))
      : Effect.succeed({ path: `${endpoint.path}/.s.PGSQL.${endpoint.port}` });
  return Effect.succeed({ host: endpoint.host ?? "127.0.0.1", port: endpoint.port });
};

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

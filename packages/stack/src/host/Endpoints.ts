import { allowedEndpointNames, type ServiceCreation } from "../services/Catalog.ts";
import { Data, Effect } from "effect";

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

export type EndpointAddressFor = (
  endpoint: string,
  from: "host" | "runtime",
) => Effect.Effect<EndpointAddress, EndpointError>;

export type EndpointPassword = () => Effect.Effect<string, EndpointError>;

export const outputsFor = (
  creation: ServiceCreation,
  address: EndpointAddressFor,
  password: EndpointPassword,
): Readonly<Record<string, Effect.Effect<string, EndpointError>>> => {
  const output = (name: string) =>
    address(name, "runtime").pipe(Effect.map(({ host, port }) => publicUrl(host, port)));
  const outputs: Record<string, Effect.Effect<string, EndpointError>> = {};
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
          password().pipe(Effect.map((value) => postgresUrl(host, port, role, value, database))),
        ),
      );
  }
  return outputs;
};

export const credentialsFor = Effect.fn("Endpoints.credentialsFor")(
  (
    creation: ServiceCreation,
    address: EndpointAddressFor,
    password: EndpointPassword,
    from: "host" | "runtime",
  ): Effect.Effect<Readonly<Record<string, string>>, EndpointError> =>
    Effect.gen(function* () {
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
        const value = yield* password();
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
    }),
);

import { Effect, Redacted } from "effect";
import {
  apiRoute,
  type Observation,
  type ServiceCreation,
  type StackCredentials,
} from "@supabase/stack/effect";
import { red } from "../../../command-internal/colors.ts";
import {
  renderStatusGroups,
  statusGroups,
  type StatusGroup,
} from "../../../command-internal/status-pretty.ts";
import { resolveOutputNames } from "../../../command-internal/status-values.ts";
import { endpointReports } from "./stack-endpoints.format.ts";

type ServiceName = ServiceCreation["service"];

export type StackServiceState =
  | "unavailable"
  | "sleeping"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "unhealthy"
  | "exited";

/** An observed service; `activation` is undefined for an instance outside the composition. */
export interface StackServiceView {
  readonly service: ServiceName;
  readonly observation: Observation | undefined;
  readonly activation: string | undefined;
  readonly error?: string | undefined;
}

/** Connection URLs derived from the observed composition members. */
export interface StackConnections {
  readonly api?: string;
  readonly rest?: string;
  readonly functions?: string;
  readonly studio?: string;
  readonly mcp?: string;
  readonly mailpit?: string;
  readonly database?: string;
}

export const serviceState = (observation: Observation | undefined): StackServiceState => {
  if (observation === undefined) return "unavailable";
  if (observation.health === "unhealthy") return "unhealthy";
  if (observation.lifecycle === "stopped") {
    if (observation.error?.operation === "exit") return "exited";
    return observation.wakeEnabled ? "sleeping" : "stopped";
  }
  return observation.lifecycle;
};

/** Reports raw endpoint observations keyed `service.endpoint`. */
export const stackEndpoints = (
  services: ReadonlyArray<Pick<StackServiceView, "service" | "observation">>,
) =>
  Object.fromEntries(
    services.flatMap(({ service, observation }) =>
      Object.entries(endpointReports(observation)).map(
        ([name, endpoint]) => [`${service}.${name}`, endpoint] as const,
      ),
    ),
  );

/** `postgres`-role connection string for users, without the tool-only query parameters `toPostgresURL` adds. */
const stackDatabaseUrl = (observation: Observation | undefined): string | undefined => {
  if (observation?.config.service !== "database") return undefined;
  const sql = observation.endpoints.find(({ name }) => name === "sql");
  if (sql === undefined) return undefined;
  const host = sql.host.includes(":") ? `[${sql.host}]` : sql.host;
  const password = Redacted.value(observation.config.config.databasePassword);
  return `postgresql://postgres:${encodeURIComponent(password)}@${host}:${sql.port}/postgres`;
};

/** Derives connection URLs; callers pass composition members only. */
export const stackConnections = (
  members: ReadonlyArray<Pick<StackServiceView, "service" | "observation">>,
): StackConnections => {
  const http = (services: ReadonlyArray<ServiceName>) =>
    members
      .filter(({ service }) => services.includes(service))
      .map(({ observation }) => endpointReports(observation).http?.url)
      .find((url) => url !== undefined);
  const api = http(
    members.map(({ service }) => service).filter((service) => apiRoute(service) !== undefined),
  );
  const routed = (service: ServiceName) => {
    const route = apiRoute(service);
    return api === undefined || route === undefined || http([service]) === undefined
      ? undefined
      : `${api}${route}`;
  };
  const rest = routed("rest");
  const functions = routed("functions");
  const studio = http(["studio"]);
  const mailpit = http(["mail"]);
  const database = stackDatabaseUrl(
    members.find(({ service }) => service === "database")?.observation,
  );
  return {
    ...(api === undefined ? {} : { api }),
    ...(rest === undefined ? {} : { rest }),
    ...(functions === undefined ? {} : { functions }),
    ...(studio === undefined ? {} : { studio }),
    // The shared API listener serves `/mcp` only when Studio is a composition member with an
    // HTTP endpoint.
    ...(api !== undefined && studio !== undefined ? { mcp: `${api}/mcp` } : {}),
    ...(mailpit === undefined ? {} : { mailpit }),
    ...(database === undefined ? {} : { database }),
  };
};

/** The `status --env` variable map; shared by `stack start`'s JSON `env` and `stack status`. */
export const connectionEnv = (
  connections: StackConnections,
  credentials:
    | Pick<StackCredentials, "publishableKey" | "secretKey" | "anonKey" | "serviceRoleKey">
    | undefined,
): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  if (connections.api !== undefined) values.API_URL = connections.api;
  if (connections.database !== undefined) values.DB_URL = connections.database;
  if (connections.studio !== undefined) values.STUDIO_URL = connections.studio;
  if (connections.mcp !== undefined) values.MCP_URL = connections.mcp;
  if (connections.mailpit !== undefined) values.MAILPIT_URL = connections.mailpit;
  if (credentials !== undefined) {
    values.PUBLISHABLE_KEY = credentials.publishableKey;
    values.SECRET_KEY = credentials.secretKey;
    values.ANON_KEY = credentials.anonKey;
    values.SERVICE_ROLE_KEY = credentials.serviceRoleKey;
  }
  return values;
};

const connectionValues = (
  connections: StackConnections,
  credentials: Pick<StackCredentials, "publishableKey" | "secretKey"> | undefined,
) => {
  const names = resolveOutputNames(new Map());
  const entries: ReadonlyArray<readonly [string, string | undefined]> = [
    [names.apiUrl, connections.api],
    [names.restUrl, connections.rest],
    [names.functionsUrl, connections.functions],
    [names.studioUrl, connections.studio],
    [names.mcpUrl, connections.mcp],
    [names.mailpitUrl, connections.mailpit],
    [names.dbUrl, connections.database],
    [names.publishableKey, credentials?.publishableKey],
    [names.secretKey, credentials?.secretKey],
  ];
  return {
    names,
    values: Object.fromEntries(
      entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    ),
  };
};

const serviceDetail = (view: StackServiceView, state: StackServiceState) => {
  const health = view.observation?.health;
  const parts: Array<string> = [state];
  if (state === "running" && health !== undefined) parts.push(health);
  if (view.activation === undefined) parts.push("standalone");
  else if (view.activation === "lazy" && state === "sleeping")
    parts.push("starts on first request");
  else parts.push(view.activation);
  return parts.join(" · ");
};

const serviceKind = (view: StackServiceView, state: StackServiceState) => {
  switch (state) {
    case "running":
      return view.observation?.health === "healthy" ? "good" : "pending";
    case "starting":
    case "stopping":
      return "pending";
    case "unhealthy":
    case "exited":
      return "bad";
    case "sleeping":
    case "stopped":
    case "unavailable":
      return "muted";
  }
};

const servicesGroup = (services: ReadonlyArray<StackServiceView>): StatusGroup => ({
  name: "🧩 Services",
  items: services.map((view) => {
    const state = serviceState(view.observation);
    return {
      label: view.service,
      value: serviceDetail(view, state),
      kind: serviceKind(view, state),
    };
  }),
});

/** Renders the member connections and service states in the legacy `status` table layout. */
export const renderStackSummary = (
  services: ReadonlyArray<StackServiceView>,
  credentials: Pick<StackCredentials, "publishableKey" | "secretKey"> | undefined,
): string => {
  const { values, names } = connectionValues(
    stackConnections(services.filter(({ activation }) => activation !== undefined)),
    credentials,
  );
  const errors = services.flatMap(({ service, error }) =>
    error === undefined ? [] : [red(`${service}: ${error}`, process.stdout)],
  );
  const groups = renderStatusGroups(
    [...statusGroups(values, names), servicesGroup(services)].filter(({ items }) =>
      items.some(({ value }) => value.length > 0),
    ),
  );
  return errors.length === 0 ? groups : `${groups}${errors.join("\n")}\n\n`;
};

/** Reads saved keys for display, warning instead of failing when they cannot be read. */
export const summaryCredentials = (
  read: Effect.Effect<StackCredentials | undefined, { readonly message: string }>,
  warn: (message: string) => Effect.Effect<void>,
) =>
  read.pipe(
    Effect.catch((error) =>
      warn(
        `The stack keys could not be read: ${error.message}. Run supabase status --env to retry.`,
      ).pipe(Effect.as(undefined)),
    ),
  );

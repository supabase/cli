import { Redacted } from "effect";
import type { Observation, ServiceCreation, StackCredentials } from "@supabase/stack/effect";
import { red } from "../../../command-internal/colors.ts";
import { toPostgresURL } from "../../../command-internal/postgres-url.ts";
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

const GATEWAY_SERVICES: ReadonlyArray<ServiceName> = [
  "rest",
  "auth",
  "storage",
  "functions",
  "realtime",
];

export const serviceState = (observation: Observation | undefined): StackServiceState => {
  if (observation === undefined) return "unavailable";
  if (observation.health === "unhealthy") return "unhealthy";
  if (observation.lifecycle === "stopped") {
    if (observation.error?.operation === "exit") return "exited";
    return observation.wakeEnabled ? "sleeping" : "stopped";
  }
  return observation.lifecycle;
};

// Studio serves MCP itself; the stack gateway has no `/mcp` route.
const mcpUrl = (studioUrl: string) => `${studioUrl}/api/mcp`;

/** Reports endpoints keyed `service.endpoint`, plus `studio.mcp` when Studio has an HTTP endpoint. */
export const stackEndpoints = (
  services: ReadonlyArray<Pick<StackServiceView, "service" | "observation">>,
) => {
  const endpoints = Object.fromEntries(
    services.flatMap(({ service, observation }) =>
      Object.entries(endpointReports(observation)).map(
        ([name, endpoint]) => [`${service}.${name}`, endpoint] as const,
      ),
    ),
  );
  const studio = endpoints["studio.http"];
  return studio === undefined
    ? endpoints
    : { ...endpoints, "studio.mcp": { ...studio, url: mcpUrl(studio.url) } };
};

const stackDatabaseUrl = (observation: Observation | undefined): string | undefined => {
  if (observation?.config.service !== "database") return undefined;
  const sql = observation.endpoints.find(({ name }) => name === "sql");
  return sql === undefined
    ? undefined
    : toPostgresURL({
        host: sql.host,
        port: sql.port,
        user: "supabase_admin",
        password: Redacted.value(observation.config.config.databasePassword),
        database: "postgres",
      });
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
  const api = http(GATEWAY_SERVICES);
  const has = (service: ServiceName) => http([service]) !== undefined;
  const studio = http(["studio"]);
  const mailpit = http(["mail"]);
  const database = stackDatabaseUrl(
    members.find(({ service }) => service === "database")?.observation,
  );
  return {
    ...(api === undefined ? {} : { api }),
    ...(api === undefined || !has("rest") ? {} : { rest: `${api}/rest/v1` }),
    ...(api === undefined || !has("functions") ? {} : { functions: `${api}/functions/v1` }),
    ...(studio === undefined ? {} : { studio, mcp: mcpUrl(studio) }),
    ...(mailpit === undefined ? {} : { mailpit }),
    ...(database === undefined ? {} : { database }),
  };
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

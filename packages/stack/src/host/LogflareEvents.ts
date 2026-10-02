import { DateTime, Option, Predicate } from "effect";
import type { ServiceCreation } from "../services/Catalog.ts";

/** Logflare source per shipped service kind; Studio's Logs pages query these names. */
export const logflareSources = {
  auth: "gotrue.logs.prod",
  rest: "postgREST.logs.prod",
  realtime: "realtime.logs.prod",
  storage: "storage.logs.prod.2",
  functions: "deno-relay-logs",
  database: "postgres.logs",
} as const satisfies Partial<Record<ServiceCreation["service"], string>>;

export type ShippedService = keyof typeof logflareSources;

export const isShippedService = (service: ServiceCreation["service"]): service is ShippedService =>
  Object.hasOwn(logflareSources, service);

/** One ingest event in the shape Studio's local log queries expect. */
export interface LogflareEvent {
  readonly project?: string;
  readonly event_message: string;
  readonly appname: ShippedService;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
}

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Predicate.isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const months: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parses PostgREST's `%d/%b/%Y:%H:%M:%S %z` prefix into an ISO-8601 timestamp. */
const parsePostgrestTime = (text: string): string | undefined => {
  const match =
    /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u.exec(text);
  if (match === null) return undefined;
  const [, day, month, year, hour, minute, second, sign, zoneHours, zoneMinutes] = match;
  const monthIndex = months[month?.toLowerCase() ?? ""];
  if (monthIndex === undefined) return undefined;
  const utc = Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMinutes = (sign === "-" ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes));
  return Option.getOrUndefined(
    Option.map(DateTime.make(utc - offsetMinutes * 60_000), DateTime.formatIso),
  );
};

/** The time and request of PostgREST's Apache combined request line. */
const postgrestRequest = /^\S+ \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+) ([^"\s]+)" (\d{3}) /u;

const withoutProject = ({ project: _project, ...event }: LogflareEvent): LogflareEvent => event;

const remaps: Record<ShippedService, (event: LogflareEvent) => LogflareEvent> = {
  auth: (event) => {
    const parsed = parseJsonObject(event.event_message);
    return parsed === undefined
      ? event
      : { ...event, metadata: { ...event.metadata, timestamp: parsed.time, ...parsed } };
  },
  rest: (event) => {
    const request = postgrestRequest.exec(event.event_message);
    const requestTime = request === null ? undefined : parsePostgrestTime(request[1] ?? "");
    if (request !== null && requestTime !== undefined)
      return {
        ...event,
        timestamp: requestTime,
        metadata: {
          ...event.metadata,
          host: event.project,
          method: request[2],
          path: request[3],
          protocol: request[4],
          status: Number(request[5]),
        },
      };
    const match = /^(.*?): (.*)$/u.exec(event.event_message);
    const timestamp = match === null ? undefined : parsePostgrestTime(match[1] ?? "");
    return match === null || timestamp === undefined
      ? event
      : {
          ...event,
          event_message: match[2] ?? "",
          timestamp,
          metadata: { ...event.metadata, host: event.project },
        };
  },
  realtime: (event) => {
    const match = /^(\d+:\d+:\d+\.\d+) \[(\w+)\] (.*)$/u.exec(event.event_message);
    const metadata = { ...event.metadata, project: event.project, external_id: event.project };
    return withoutProject(
      match === null
        ? { ...event, metadata }
        : { ...event, event_message: match[3] ?? "", metadata: { ...metadata, level: match[2] } },
    );
  },
  storage: (event) => {
    const parsed = parseJsonObject(event.event_message);
    const metadata = { ...event.metadata, project: event.project, tenantId: event.project };
    return withoutProject(
      parsed === undefined
        ? { ...event, metadata }
        : {
            ...event,
            event_message: typeof parsed.msg === "string" ? parsed.msg : event.event_message,
            metadata: {
              ...metadata,
              level: parsed.level,
              timestamp: parsed.time,
              context: [{ host: parsed.hostname, pid: parsed.pid }],
            },
          },
    );
  },
  functions: (event) =>
    withoutProject({ ...event, metadata: { ...event.metadata, project_ref: event.project } }),
  database: (event) => {
    const match = /.*(INFO|NOTICE|WARNING|ERROR|LOG|FATAL|PANIC):/u.exec(event.event_message);
    return {
      ...event,
      metadata: {
        ...event.metadata,
        host: "db-default",
        parsed: { timestamp: event.timestamp, error_severity: match?.[1] ?? "LOG" },
      },
    };
  },
};

/** Builds the Logflare event for one service log line received at `timestamp`. */
export const logflareEvent = (
  service: ShippedService,
  timestamp: string,
  message: string,
): LogflareEvent =>
  remaps[service]({
    project: "default",
    event_message: message,
    appname: service,
    timestamp,
    metadata: {},
  });

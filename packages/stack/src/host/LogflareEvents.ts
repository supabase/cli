import { DateTime, Option, Predicate } from "effect";
import type { ServiceCreation } from "../services/Catalog.ts";
import type { gatewayLog } from "./GatewayLog.ts";

/** A service kind, or the owner's `gateway` stream of shared API listener requests. */
type LogService = ServiceCreation["service"] | typeof gatewayLog.service;

/** Logflare source per shipped log service; Studio's Logs pages query these names. */
export const logflareSources = {
  auth: "gotrue.logs.prod",
  rest: "postgREST.logs.prod",
  realtime: "realtime.logs.prod",
  storage: "storage.logs.prod.2",
  functions: "deno-relay-logs",
  database: "postgres.logs",
  gateway: "cloudflare.logs.prod",
} as const satisfies Partial<Record<LogService, string>>;

export type ShippedService = keyof typeof logflareSources;

export const isShippedService = (service: LogService): service is ShippedService =>
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

/** The `%b` month abbreviations of PostgREST and nginx log times, January first. */
export const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Parses the `%d/%b/%Y:%H:%M:%S %z` time of PostgREST and nginx logs into ISO-8601. */
const parseLogTime = (text: string): string | undefined => {
  const match =
    /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u.exec(text);
  if (match === null) return undefined;
  const [, day, month, year, hour, minute, second, sign, zoneHours, zoneMinutes] = match;
  const monthIndex = monthNames.findIndex((name) => name.toLowerCase() === month?.toLowerCase());
  if (monthIndex < 0) return undefined;
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

/** The gateway's nginx combined line with its trailing duration. */
const gatewayRequest =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) (\S+)" (\d{3}) (?:\d+|-) "([^"]*)" "([^"]*)" \d+ms$/u;

const unescapeLogValue = (value: string) =>
  value.replace(/\\x([0-9a-f]{2})/giu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** A quoted combined-log field, absent when nginx wrote `-`. */
const logValue = (value: string | undefined) =>
  value === undefined || value === "-" ? undefined : unescapeLogValue(value);

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
    const requestTime = request === null ? undefined : parseLogTime(request[1] ?? "");
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
    const match = /^(.*): (.*)$/u.exec(event.event_message);
    const timestamp = match === null ? undefined : parseLogTime(match[1] ?? "");
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
  gateway: (event) => {
    const match = gatewayRequest.exec(event.event_message);
    const timestamp = match === null ? undefined : parseLogTime(match[2] ?? "");
    if (match === null || timestamp === undefined) return event;
    const [, client, , method, target = "", protocol, status, referer, userAgent] = match;
    const decoded = unescapeLogValue(target);
    const queryAt = decoded.indexOf("?");
    const refererHeader = logValue(referer);
    const userAgentHeader = logValue(userAgent);
    return {
      ...event,
      timestamp,
      metadata: {
        ...event.metadata,
        request: {
          method,
          path: queryAt < 0 ? decoded : decoded.slice(0, queryAt),
          ...(queryAt < 0 ? {} : { search: decoded.slice(queryAt) }),
          protocol,
          headers: {
            cf_connecting_ip: client,
            ...(refererHeader === undefined ? {} : { referer: refererHeader }),
            ...(userAgentHeader === undefined ? {} : { user_agent: userAgentHeader }),
          },
        },
        response: { status_code: Number(status) },
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

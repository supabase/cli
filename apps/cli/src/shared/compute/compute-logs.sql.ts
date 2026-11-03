import { DateTime } from "effect";

export const COMPUTE_LOG_STREAMS = {
  app: "worker_guest_logs",
  requests: "worker_ingress_logs",
  builds: "worker_api_logs",
} as const;

export type ComputeLogKindChoice = keyof typeof COMPUTE_LOG_STREAMS;

export const COMPUTE_LOG_KINDS = [
  "app",
  "requests",
  "builds",
] as const satisfies ReadonlyArray<ComputeLogKindChoice>;

export const ALL_COMPUTE_LOG_STREAMS: ReadonlyArray<string> = Object.values(COMPUTE_LOG_STREAMS);

const COMPUTE_LOG_NAME_ATTRIBUTE = "worker";

const COMPUTE_LOG_STREAM_ATTRIBUTE = "subservice";

export const COMPUTE_LOG_WINDOW_MINUTES = 23 * 60 + 59;

export const COMPUTE_LOG_POLL_SECONDS = 10;

const COMPUTE_LOG_CURSOR_GRACE_SECONDS = 60;

export function logWindow(now: DateTime.Utc): { readonly start: string; readonly end: string } {
  return {
    start: DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - COMPUTE_LOG_WINDOW_MINUTES * 60_000),
    ),
    end: DateTime.formatIso(now),
  };
}

export function followWindow(
  now: DateTime.Utc,
  newestSeen: DateTime.Utc,
): { readonly start: string; readonly end: string } {
  const earliest = DateTime.toEpochMillis(now) - COMPUTE_LOG_WINDOW_MINUTES * 60_000;
  return {
    start: DateTime.formatIso(
      DateTime.makeUnsafe(
        Math.max(
          DateTime.toEpochMillis(newestSeen) - COMPUTE_LOG_CURSOR_GRACE_SECONDS * 1000,
          earliest,
        ),
      ),
    ),
    end: DateTime.formatIso(now),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function computeLogsQuery(options: {
  readonly name: string;
  readonly streams: ReadonlyArray<string>;
  readonly tail: number;
}): string {
  const streams = options.streams.map(quote).join(", ");
  return (
    `select id, ` +
    `toUnixTimestamp64Milli(timestamp) as ts_ms, ` +
    `log_attributes['${COMPUTE_LOG_STREAM_ATTRIBUTE}'] as stream, ` +
    `event_message, ` +
    `log_attributes ` +
    `from logs ` +
    `where log_attributes['${COMPUTE_LOG_NAME_ATTRIBUTE}'] = ${quote(options.name)} ` +
    `and log_attributes['${COMPUTE_LOG_STREAM_ATTRIBUTE}'] in (${streams}) ` +
    `order by timestamp desc ` +
    `limit ${options.tail}`
  );
}

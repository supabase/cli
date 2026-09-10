/**
 * The ClickHouse query `supabase experimental workers logs` sends, and the two
 * literals it turns on.
 *
 * Pure — no Effect, no services — so the query text and the window arithmetic are
 * unit-testable without a stubbed API, and so the literals have exactly one home
 * if the log pipeline ever renames a stream.
 */

/**
 * The three streams that share the Workers Logflare source, keyed by the word the `--kind`
 * flag exposes (`worker_guest_logs` is internal; `app` is what a user means). Lives here
 * rather than in the command so the flag and the query cannot drift apart.
 */
export const WORKER_LOG_STREAMS = {
  app: "worker_guest_logs",
  requests: "worker_ingress_logs",
  builds: "worker_api_logs",
} as const;

export type WorkerLogKindChoice = keyof typeof WORKER_LOG_STREAMS;

/**
 * The `--kind` words, in the order help lists them. Checked against {@link WORKER_LOG_STREAMS}
 * so the flag can't offer a word the query has no stream for — without that link, an added
 * choice would index the map as `undefined` and reach the SQL as an empty stream name.
 */
export const WORKER_LOG_KINDS = [
  "app",
  "requests",
  "builds",
] as const satisfies ReadonlyArray<WorkerLogKindChoice>;

/** Every stream, for an invocation that named none. */
export const ALL_WORKER_LOG_STREAMS: ReadonlyArray<string> = Object.values(WORKER_LOG_STREAMS);

/**
 * Which `log_attributes` key carries the worker name.
 *
 * The Logflare writer stamps `metadata.worker`, and the whole metadata map lands
 * in `log_attributes` on the ClickHouse side.
 */
const WORKER_LOG_NAME_ATTRIBUTE = "worker";

/** Which key carries the stream name. See {@link workerLogsQuery} for why. */
const WORKER_LOG_STREAM_ATTRIBUTE = "source";

/**
 * The server clamps a span of more than 24 hours, so the default window sits just under the
 * boundary. Being clamped is worse than being rejected: the server rewrites `end` to
 * `start + 24h`, so an over-wide request silently returns an older slice than the one asked for.
 */
export const WORKER_LOG_WINDOW_MINUTES = 23 * 60 + 59;

/**
 * How often `--follow` re-queries — set by the rate limit, not by responsiveness. The v1
 * analytics endpoints allow 10 requests per 60 seconds, so a two-second poll would 429 within
 * the first ten seconds; ten seconds leaves room for the initial history query, the
 * deployed-worker check, and a retry inside the same window.
 */
export const WORKER_LOG_POLL_SECONDS = 10;

/**
 * How far behind the newest line seen the next window starts. Guest lines are relayed
 * CloudWatch -> subscription filter -> Lambda -> Logflare and arrive late and out of order, so
 * a cursor sitting exactly on the newest timestamp would drop every straggler permanently —
 * the window re-asks for ground already covered, and `id` dedupe absorbs the overlap. Wider
 * than one poll interval, so a line delayed a full cycle still lands inside the next window.
 */
const WORKER_LOG_CURSOR_GRACE_SECONDS = 60;

/**
 * Timestamps for the endpoint's `iso_timestamp_start`/`iso_timestamp_end`.
 *
 * The v1 DTO validates these with `z.string().datetime()`, which requires a
 * trailing `Z` and rejects numeric offsets — so this is `toISOString()` and must
 * stay that way.
 */
export function isoLogTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * A closed window ending at `now`. Both bounds, always: sending only a start yields a
 * one-minute window server-side (the lone bound is minute-rounded and the other derived from
 * it), and sending neither is an outright error, so there's no valid single-bound call.
 */
export function logWindow(now: Date): { readonly start: string; readonly end: string } {
  return {
    start: isoLogTimestamp(new Date(now.getTime() - WORKER_LOG_WINDOW_MINUTES * 60_000)),
    end: isoLogTimestamp(now),
  };
}

/**
 * The window for one `--follow` poll: from just before the newest line seen, up to now.
 * Clamped to the same sub-24h span as {@link logWindow} — a tail left running past a laptop
 * suspend would otherwise resume with a wider span, and the server answers that by rewriting
 * `end` to `start + 24h`, returning an older slice rather than a truncated one, so a resumed
 * tail would silently start replaying yesterday.
 */
export function followWindow(
  now: Date,
  newestSeenMs: number,
): { readonly start: string; readonly end: string } {
  const earliest = now.getTime() - WORKER_LOG_WINDOW_MINUTES * 60_000;
  return {
    start: isoLogTimestamp(
      new Date(Math.max(newestSeenMs - WORKER_LOG_CURSOR_GRACE_SECONDS * 1000, earliest)),
    ),
    end: isoLogTimestamp(now),
  };
}

/**
 * Single-quoted SQL string literal.
 *
 * Every value this module interpolates is either an internal constant or a name
 * `validateWorkerName` has already reduced to a DNS label, so this is a
 * backstop rather than the guard. It exists so the guarantee does not rest on a
 * caller remembering to validate first.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The logs query for one worker. Two things about the projection are load-bearing: the filter
 * is `log_attributes`, not the `source` column, since worker rows carry an empty top-level
 * `source` (the stream survives only in `log_attributes['source']`); and the `in (...)` list
 * is a tenancy guard, not a convenience — with `source` empty, it's the only thing keeping a
 * non-worker row with a `worker` attribute out of the result. `toUnixTimestamp64Milli` rather
 * than a formatter, since ClickHouse's `%M` is the month name and bare `toString(timestamp)`
 * has no zone.
 */
export function workerLogsQuery(options: {
  readonly name: string;
  readonly streams: ReadonlyArray<string>;
  readonly tail: number;
}): string {
  const streams = options.streams.map(quote).join(", ");
  return (
    `select id, ` +
    `toUnixTimestamp64Milli(timestamp) as ts_ms, ` +
    `log_attributes['${WORKER_LOG_STREAM_ATTRIBUTE}'] as stream, ` +
    `event_message, ` +
    `log_attributes ` +
    `from logs ` +
    `where log_attributes['${WORKER_LOG_NAME_ATTRIBUTE}'] = ${quote(options.name)} ` +
    `and log_attributes['${WORKER_LOG_STREAM_ATTRIBUTE}'] in (${streams}) ` +
    `order by timestamp desc ` +
    `limit ${options.tail}`
  );
}

/**
 * The ClickHouse query `supabase experimental workers logs` sends, and the two literals it
 * turns on.
 *
 * Pure — no Effect, no services — so the query text and the window arithmetic are
 * unit-testable without a stubbed API, and so the literals have exactly one home
 * if the log pipeline ever renames a stream.
 *
 * Everything here was verified against a real project; see
 * `scratch/FINDINGS-worker-logs.md` for the captured rows.
 */

/**
 * The three streams that share the Workers Logflare source, keyed by the word the
 * `--source` flag exposes.
 *
 * `worker_guest_logs` is an internal name; `app` is what a user means. The
 * mapping lives here rather than in the command so the flag and the query cannot
 * drift apart.
 */
export const WORKER_LOG_STREAMS = {
  app: "worker_guest_logs",
  requests: "worker_ingress_logs",
  builds: "worker_api_logs",
} as const;

export type WorkerLogSourceChoice = keyof typeof WORKER_LOG_STREAMS;

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
 * The server clamps a span of *more than* 24 hours, so the default window sits
 * just under the boundary rather than on it.
 *
 * Being clamped is worse than being rejected: the server rewrites `end` to
 * `start + 24h`, so an over-wide request silently returns an *older* slice than
 * the one asked for.
 */
export const WORKER_LOG_WINDOW_MINUTES = 23 * 60 + 59;

/**
 * How often `--follow` re-queries.
 *
 * **Set by the rate limit, not by responsiveness.** The v1 analytics endpoints
 * allow 10 requests per 60 seconds, so the two-second poll a live tail suggests
 * would 429 within the first ten seconds. Six seconds is the arithmetic floor;
 * ten leaves room for the initial history query, the deployed-worker check, and a
 * retry inside the same window.
 */
export const WORKER_LOG_POLL_SECONDS = 10;

/**
 * How far behind the newest line seen the next window starts.
 *
 * Guest lines are relayed CloudWatch -> subscription filter -> Lambda -> Logflare
 * and arrive **late and out of order**, so a cursor sitting exactly on the newest
 * timestamp drops every straggler permanently. The window is deliberately
 * re-asked for ground it has already covered; `id` dedupe absorbs the overlap.
 *
 * Wider than one poll interval, so a line delayed by a full cycle is still
 * inside the next window.
 */
export const WORKER_LOG_CURSOR_GRACE_SECONDS = 60;

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
 * A closed window ending at `now`.
 *
 * Both bounds, always. Sending only a start yields a **one-minute** window
 * server-side (the lone bound is minute-rounded and the other derived from it),
 * and sending neither is an outright error — so there is no valid single-bound
 * call to make.
 */
export function logWindow(
  now: Date,
  spanMinutes: number = WORKER_LOG_WINDOW_MINUTES,
): { readonly start: string; readonly end: string } {
  return {
    start: isoLogTimestamp(new Date(now.getTime() - spanMinutes * 60_000)),
    end: isoLogTimestamp(now),
  };
}

/**
 * The window for one `--follow` poll: from just before the newest line seen, up
 * to now.
 *
 * Clamped to the same sub-24h span as {@link logWindow}. That matters when a tail
 * is left running past a laptop suspend: without the clamp the resumed poll would
 * ask for a wider span, and the server answers an over-wide request by rewriting
 * `end` to `start + 24h` — returning an *older* slice rather than a truncated one,
 * so a resumed tail would silently start replaying yesterday.
 */
export function followWindow(
  now: Date,
  newestSeenMs: number,
  options: {
    readonly graceSeconds?: number;
    readonly spanMinutes?: number;
  } = {},
): { readonly start: string; readonly end: string } {
  const grace = (options.graceSeconds ?? WORKER_LOG_CURSOR_GRACE_SECONDS) * 1000;
  const spanMs = (options.spanMinutes ?? WORKER_LOG_WINDOW_MINUTES) * 60_000;
  const earliest = now.getTime() - spanMs;
  return {
    start: isoLogTimestamp(new Date(Math.max(newestSeenMs - grace, earliest))),
    end: isoLogTimestamp(now),
  };
}

/**
 * Single-quoted SQL string literal.
 *
 * Every value this module interpolates is either an internal constant or a name
 * `legacyValidateWorkerName` has already reduced to a DNS label, so this is a
 * backstop rather than the guard. It exists so the guarantee does not rest on a
 * caller remembering to validate first.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The logs query for one worker.
 *
 * Two things about the projection are load-bearing:
 *
 * - **The filter is `log_attributes`, not the `source` column.** Worker rows carry
 *   an empty top-level `source`, because the Workers Logflare source is not
 *   enrolled as a category in the generic logs path — so `where source =
 *   'worker_guest_logs'` matches nothing. The stream survives only in
 *   `log_attributes['source']`.
 * - **The `in (...)` list is a tenancy guard, not a convenience.** With `source`
 *   empty there is nothing else keeping a non-worker row that happens to carry a
 *   `worker` attribute out of the result.
 *
 * `toUnixTimestamp64Milli` rather than a formatter: ClickHouse's `%M` is the
 * *month name*, and bare `toString(timestamp)` yields
 * `2026-08-31 14:45:32.576000000` — space-separated, nine decimals, no zone.
 * Epoch milliseconds have no such trap and sort as a number.
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
